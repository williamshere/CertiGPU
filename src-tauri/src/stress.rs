//! GPU load generation and VRAM integrity testing via wgpu compute shaders.
//!
//! No CUDA toolkit required: a WGSL compute shader does ALU-heavy integer
//! hashing in a loop, which saturates the GPU's compute units. A second
//! shader writes a known pattern across a large buffer that is read back and
//! verified — a genuine VRAM integrity test.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

const WORKGROUP_SIZE: u32 = 256;
/// 4M u32 elements = 16 MiB per dispatch — big enough to keep the GPU busy,
//  small enough to fit anywhere.
const ELEMENTS: u32 = 4_194_304;
/// Size of the VRAM pattern-test buffer (512 MiB).
const VRAM_TEST_MB: u64 = 512;

/// ALU-heavy integer hash avalanche. Memory-light on purpose so the
/// bottleneck is the compute units, not VRAM bandwidth.
const BURN_SHADER: &str = r#"
@group(0) @binding(0) var<storage, read_write> data: array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    var x: u32 = id.x ^ 0x9E3779B9u;
    for (var i: u32 = 0u; i < 4000u; i = i + 1u) {
        x = x ^ (x >> 16u);
        x = x * 0x7feb352du;
        x = x ^ (x >> 15u);
        x = x * 0x846ca68bu;
        x = x ^ (x >> 16u);
    }
    data[id.x] = x;
}
"#;

/// Writes a deterministic pattern: data[i] = i ^ 0xDEADBEEF.
const PATTERN_SHADER: &str = r#"
@group(0) @binding(0) var<storage, read_write> data: array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    data[id.x] = id.x ^ 0xDEADBEEFu;
}
"#;

pub struct GpuContext {
    device: wgpu::Device,
    queue: wgpu::Queue,
}

impl GpuContext {
    /// Acquire the high-performance GPU adapter. Fails on machines without a
    /// discrete GPU / usable graphics driver — the caller falls back to
    /// simulated mode.
    pub async fn new() -> Result<Self, String> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::default());
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: None,
                force_fallback_adapter: false,
            })
            .await
            .ok_or_else(|| "no high-performance GPU adapter found".to_string())?;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default(), None)
            .await
            .map_err(|e| format!("failed to open GPU device: {}", e))?;
        Ok(Self { device, queue })
    }

    fn make_pipeline(&self, shader_src: &str) -> (wgpu::ComputePipeline, wgpu::BindGroup, wgpu::Buffer) {
        let shader = self.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("certigpu-shader"),
            source: wgpu::ShaderSource::Wgsl(shader_src.into()),
        });
        let buffer_size = (ELEMENTS as u64) * 4;
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("certigpu-storage"),
            size: buffer_size,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let bind_group_layout =
            self.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("certigpu-bgl"),
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: false },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                }],
            });
        let pipeline_layout = self.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("certigpu-pl"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });
        let pipeline = self.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("certigpu-pipeline"),
            layout: Some(&pipeline_layout),
            module: &shader,
            entry_point: "main",
            compilation_options: wgpu::PipelineCompilationOptions::default(),
        });
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("certigpu-bg"),
            layout: &bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: buffer.as_entire_binding(),
            }],
        });
        (pipeline, bind_group, buffer)
    }

    /// Write a known pattern across a large VRAM buffer, read it back, and
    /// count mismatches. Returns the number of bad words (0 = healthy).
    ///
    /// Runs in 32 MiB chunks: wgpu caps a single buffer at
    /// `device.limits().max_buffer_size` (256 MiB on many backends, e.g. the
    /// DX12 backend on Windows), and a compute dispatch at 65535 workgroups
    /// per dimension — one 512 MiB allocation (or a 128 MiB dispatch)
    /// panics the whole certification task.
    pub async fn vram_pattern_test(&self) -> Result<u32, String> {
        const CHUNK_MB: u64 = 32;
        let chunk_size = CHUNK_MB * 1024 * 1024;
        let chunks = VRAM_TEST_MB / CHUNK_MB;
        let mut total_errors: u32 = 0;
        for _ in 0..chunks {
            total_errors += self.vram_chunk_test(chunk_size).await?;
            if total_errors > 64 {
                break; // cap the count; the card is clearly bad
            }
        }
        Ok(total_errors)
    }

    /// One chunk of the VRAM pattern test over a `size`-byte buffer.
    async fn vram_chunk_test(&self, size: u64) -> Result<u32, String> {
        let elements = (size / 4) as u32;

        let shader = self.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("certigpu-vram-shader"),
            source: wgpu::ShaderSource::Wgsl(PATTERN_SHADER.into()),
        });
        let storage = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("certigpu-vram"),
            size,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let staging = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("certigpu-staging"),
            size,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bind_group_layout =
            self.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("certigpu-vram-bgl"),
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: false },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                }],
            });
        let pipeline_layout = self.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("certigpu-vram-pl"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });
        let pipeline = self.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("certigpu-vram-pipeline"),
            layout: Some(&pipeline_layout),
            module: &shader,
            entry_point: "main",
            compilation_options: wgpu::PipelineCompilationOptions::default(),
        });
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("certigpu-vram-bg"),
            layout: &bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: storage.as_entire_binding(),
            }],
        });

        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("certigpu-vram-enc"),
        });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.dispatch_workgroups(elements / WORKGROUP_SIZE, 1, 1);
        }
        encoder.copy_buffer_to_buffer(&storage, 0, &staging, 0, size);
        self.queue.submit(Some(encoder.finish()));

        let slice = staging.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        self.device.poll(wgpu::Maintain::Wait);
        rx.recv()
            .map_err(|_| "VRAM readback channel closed".to_string())?
            .map_err(|e| format!("VRAM buffer map failed: {:?}", e))?;

        let data = slice.get_mapped_range();
        let mut errors: u32 = 0;
        for (i, chunk) in data.chunks_exact(4).enumerate() {
            let word = u32::from_ne_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            if word != (i as u32) ^ 0xDEADBEEF {
                errors += 1;
                if errors > 64 {
                    break; // cap the count; the card is clearly bad
                }
            }
        }
        drop(data);
        staging.unmap();
        Ok(errors)
    }

    /// Sustained compute load until `stop` is set. Each iteration dispatches
    /// one full ALU-heavy pass and waits for it, keeping the GPU saturated.
    /// Synchronous by design — run it on a blocking thread.
    pub fn burn(&self, stop: &Arc<AtomicBool>) {
        let (pipeline, bind_group, _buffer) = self.make_pipeline(BURN_SHADER);
        let workgroups = ELEMENTS / WORKGROUP_SIZE;
        while !stop.load(Ordering::Relaxed) {
            let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("certigpu-burn-enc"),
            });
            {
                let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
                pass.set_pipeline(&pipeline);
                pass.set_bind_group(0, &bind_group, &[]);
                pass.dispatch_workgroups(workgroups, 1, 1);
            }
            self.queue.submit(Some(encoder.finish()));
            // Pacing: wait for the dispatch so load stays sustained instead
            // of queueing unbounded work.
            let _ = self.device.poll(wgpu::Maintain::Wait);
        }
    }
}
