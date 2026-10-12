import { createClient } from '@supabase/supabase-js';

// These should be configured in your .env or .env.local file.
// For example:
// VITE_SUPABASE_URL=https://your-project.supabase.co
// VITE_SUPABASE_ANON_KEY=your-anon-key

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://mock-project.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'mock-anon-key';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export async function uploadCertificate(reportData) {
    if (supabaseUrl.includes('mock-project')) {
        console.warn('Using mock Supabase URL. Configure VITE_SUPABASE_URL to upload for real.');
        // Simulate network delay
        await new Promise(resolve => setTimeout(resolve, 1000));
        return { success: true, data: reportData };
    }

    const { data, error } = await supabase
        .from('certificates')
        .insert([
            {
                cert_id: reportData.cert_id,
                gpu_name: reportData.gpu_name || 'Unknown GPU',
                health_score: reportData.health_score,
                verdict: reportData.verdict,
                summary: reportData.summary,
                report_json: reportData
            }
        ]);

    if (error) {
        console.error('Supabase upload error:', error);
        throw error;
    }

    return { success: true, data };
}
