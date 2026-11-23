CREATE TABLE public.cron_nonces (nonce text PRIMARY KEY CHECK (nonce ~ '^[0-9a-f]{32}$'), seen_at timestamptz NOT NULL DEFAULT now());
GRANT ALL ON public.cron_nonces TO service_role;
ALTER TABLE public.cron_nonces ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION public.sdf_log_cleanup() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ BEGIN DELETE FROM public.cron_nonces WHERE seen_at < pg_catalog.now() - interval '15 minutes'; DELETE FROM public.app_logs WHERE created_at < pg_catalog.now() - interval '30 days'; DELETE FROM public.client_errors WHERE created_at < pg_catalog.now() - interval '30 days'; END $$;
REVOKE ALL ON FUNCTION public.sdf_log_cleanup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sdf_log_cleanup() TO service_role;