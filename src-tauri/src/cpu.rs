//! Bounded CPU workloads with verified output and cooperative cancellation.
use std::hint::black_box;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

pub fn logical_threads() -> usize {
    std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
}

fn integer_result(mut value: u64) -> u64 {
    for _ in 0..4096 {
        value ^= value >> 16;
        value = value.wrapping_mul(0x7feb352d);
        value ^= value >> 15;
        value = value.wrapping_mul(0x846ca68b);
        value ^= value >> 16;
    }
    value
}

fn float_result(seed: f64) -> f64 {
    let mut value = seed;
    for i in 1..4096 {
        value = (value + (i as f64).sqrt()).sin().mul_add(0.5, 0.5);
    }
    value
}

pub fn memory_check(memory: &mut [u64], pattern: u64) -> bool {
    for (i, word) in memory.iter_mut().enumerate() {
        *word = (i as u64) ^ pattern;
    }
    black_box(&mut *memory);
    memory
        .iter()
        .enumerate()
        .all(|(i, word)| *word == (i as u64) ^ pattern)
}

pub fn run_worker(
    stop: Arc<AtomicBool>,
    batches: Arc<AtomicU64>,
    errors: Arc<AtomicU64>,
    workload: String,
    intensity: u64,
    deadline: Instant,
) {
    let integer_expected = integer_result(1234567);
    let float_expected = float_result(0.5);
    let mut memory = vec![0u64; 131072]; // 1 MiB per worker, at most 32 MiB.
    let mut iteration = 0u64;
    while !stop.load(Ordering::Relaxed) && Instant::now() < deadline {
        let cycle = Instant::now();
        let active = Duration::from_millis(intensity.clamp(10, 100));
        while cycle.elapsed() < active && !stop.load(Ordering::Relaxed) && Instant::now() < deadline
        {
            let mode = if workload == "mixed" {
                ["integer", "float", "memory"][(iteration % 3) as usize]
            } else {
                workload.as_str()
            };
            let valid = match mode {
                "integer" => black_box(integer_result(black_box(1234567))) == integer_expected,
                "float" => {
                    let result = black_box(float_result(black_box(0.5)));
                    result.is_finite() && (result - float_expected).abs() < 1e-12
                }
                "memory" => memory_check(
                    &mut memory,
                    if iteration % 2 == 0 {
                        0xaaaaaaaaaaaaaaaa
                    } else {
                        0x5555555555555555
                    },
                ),
                _ => false,
            };
            if !valid {
                errors.fetch_add(1, Ordering::Relaxed);
                stop.store(true, Ordering::SeqCst);
                return;
            }
            batches.fetch_add(1, Ordering::Relaxed);
            iteration += 1;
        }
        let rest = Duration::from_millis(100).saturating_sub(cycle.elapsed());
        std::thread::sleep(rest.min(deadline.saturating_duration_since(Instant::now())));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn memory_patterns_roundtrip() {
        for pattern in [0, u64::MAX, 0xaaaaaaaaaaaaaaaa, 0x5555555555555555] {
            assert!(memory_check(&mut vec![0; 1024], pattern));
        }
    }
    #[test]
    fn all_workloads_complete_verified_batches() {
        for workload in ["mixed", "integer", "float", "memory"] {
            let batches = Arc::new(AtomicU64::new(0));
            let errors = Arc::new(AtomicU64::new(0));
            run_worker(
                Arc::new(AtomicBool::new(false)),
                batches.clone(),
                errors.clone(),
                workload.into(),
                50,
                Instant::now() + Duration::from_millis(120),
            );
            assert!(batches.load(Ordering::Relaxed) > 0);
            assert_eq!(errors.load(Ordering::Relaxed), 0);
        }
    }
    #[test]
    fn stopped_worker_exits_without_work() {
        let batches = Arc::new(AtomicU64::new(0));
        run_worker(
            Arc::new(AtomicBool::new(true)),
            batches.clone(),
            Arc::new(AtomicU64::new(0)),
            "mixed".into(),
            100,
            Instant::now() + Duration::from_secs(60),
        );
        assert_eq!(batches.load(Ordering::Relaxed), 0);
    }
}
