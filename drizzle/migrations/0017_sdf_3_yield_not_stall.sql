-- 预算用完后主动让出的步骤应回到 pending，不算崩溃。只有租约过期仍停在 running 才累计中断次数。

CREATE OR REPLACE FUNCTION public.save_step_chunk(_step uuid, _lease uuid, _cursor_seq integer, _cursor jsonb, _payload jsonb, _progress text, _tokens integer, _calls integer, _release boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.step_runs; n integer;
BEGIN
  s := public.sdf_lock_leased(_step, _lease);
  INSERT INTO public.step_chunk_results(step_run_id, attempt, cursor_seq, payload) VALUES (_step, s.attempt, _cursor_seq, COALESCE(_payload,'{}'::jsonb)) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 1 THEN
    UPDATE public.step_runs SET cursor = _cursor, cursor_seq = GREATEST(cursor_seq, _cursor_seq + 1), progress_text = left(_progress, 500),
      tokens = tokens + COALESCE(_tokens,0), model_calls = model_calls + COALESCE(_calls,0) WHERE id = _step;
    PERFORM public.sdf_event(_step, 'progress', COALESCE(_progress, '分片完成'), jsonb_build_object('cursor_seq', _cursor_seq));
  END IF;
  UPDATE public.step_runs SET heartbeat_at = now(),
    status = CASE WHEN _release THEN 'pending' ELSE status END,
    lease_token = CASE WHEN _release THEN NULL ELSE lease_token END,
    lease_expires_at = CASE WHEN _release THEN NULL ELSE now() + interval '60 seconds' END
  WHERE id = _step;
  RETURN n = 1;
END $$;
