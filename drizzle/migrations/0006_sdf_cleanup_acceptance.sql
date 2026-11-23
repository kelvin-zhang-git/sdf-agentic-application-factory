CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE TABLE public.cleanup_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), finished_at timestamptz NOT NULL DEFAULT now(), nonce_count integer NOT NULL, log_count integer NOT NULL, client_count integer NOT NULL);
GRANT SELECT ON public.cleanup_runs TO authenticated;
GRANT ALL ON public.cleanup_runs TO service_role;
ALTER TABLE public.cleanup_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY cleanup_admin_read ON public.cleanup_runs FOR SELECT TO authenticated USING (public.is_admin());
CREATE OR REPLACE FUNCTION public.sdf_log_cleanup() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE n integer; l integer; c integer;
BEGIN
DELETE FROM public.cron_nonces WHERE nonce IN (SELECT nonce FROM public.cron_nonces WHERE seen_at < pg_catalog.now()-interval '15 minutes' ORDER BY seen_at LIMIT 1000); GET DIAGNOSTICS n = ROW_COUNT;
DELETE FROM public.app_logs WHERE id IN (SELECT id FROM public.app_logs WHERE created_at < pg_catalog.now()-interval '30 days' ORDER BY created_at LIMIT 1000); GET DIAGNOSTICS l = ROW_COUNT;
DELETE FROM public.client_errors WHERE id IN (SELECT id FROM public.client_errors WHERE created_at < pg_catalog.now()-interval '30 days' ORDER BY created_at LIMIT 1000); GET DIAGNOSTICS c = ROW_COUNT;
DELETE FROM public.cleanup_runs WHERE id IN (SELECT id FROM public.cleanup_runs WHERE finished_at < pg_catalog.now()-interval '30 days' ORDER BY finished_at LIMIT 1000);
INSERT INTO public.cleanup_runs(nonce_count,log_count,client_count) VALUES(n,l,c);
END $$;
REVOKE ALL ON FUNCTION public.sdf_log_cleanup() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sdf_log_cleanup() TO service_role;