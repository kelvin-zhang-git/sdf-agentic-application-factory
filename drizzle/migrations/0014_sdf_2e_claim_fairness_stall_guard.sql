ALTER TABLE public.step_runs ADD COLUMN IF NOT EXISTS lease_reclaims integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.claim_step(_run uuid, _lease_seconds integer) RETURNS TABLE(step_run_id uuid, lease_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE sid uuid; tok uuid := gen_random_uuid(); was text; n integer; rid uuid;
BEGIN
  LOOP
    sid := NULL;
    SELECT s.id, s.status, s.lease_reclaims, s.run_id INTO sid, was, n, rid FROM public.step_runs s JOIN public.workflow_runs r ON r.id = s.run_id
    WHERE s.is_current AND r.status = 'running' AND (_run IS NULL OR s.run_id = _run)
      AND ((s.status = 'pending' AND s.seq = (SELECT min(x.seq) FROM public.step_runs x WHERE x.run_id = s.run_id AND x.is_current AND x.status NOT IN ('succeeded','skipped')))
        OR (s.status = 'running' AND s.lease_expires_at < now()))
    -- fresh work first, then the longest-expired lease, so one stuck step cannot starve other runs
    ORDER BY (s.status = 'running'), s.lease_expires_at NULLS FIRST, s.created_at LIMIT 1 FOR UPDATE OF s SKIP LOCKED;
    IF sid IS NULL THEN RETURN; END IF;
    IF was = 'running' AND n >= 3 THEN
      UPDATE public.step_runs SET status = 'failed', lease_token = NULL, lease_expires_at = NULL, finished_at = now(),
        error = jsonb_build_object('code','STEP_STALLED','message','步骤多次中断未完成，已停止；请检查后重试') WHERE id = sid;
      PERFORM public.sdf_event(sid, 'error', '步骤多次中断未完成，已停止');
      PERFORM public.sdf_refresh_run(rid);
      CONTINUE;
    END IF;
    UPDATE public.step_runs SET status = 'running', lease_token = tok, lease_expires_at = now() + make_interval(secs => _lease_seconds),
      heartbeat_at = now(), started_at = COALESCE(started_at, now()),
      lease_reclaims = CASE WHEN was = 'running' THEN lease_reclaims + 1 ELSE 0 END WHERE id = sid;
    PERFORM public.sdf_event(sid, 'status', CASE WHEN was = 'running' THEN '从断点继续执行' ELSE '开始执行' END);
    step_run_id := sid; lease_token := tok; RETURN NEXT; RETURN;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.claim_step(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_step(uuid, integer) TO service_role;