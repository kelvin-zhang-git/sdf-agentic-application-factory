CREATE OR REPLACE FUNCTION public.merge_step_results(_step uuid, _lease uuid, _result jsonb, _summary text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.step_runs; x jsonb; outs jsonb := '[]'::jsonb; aid uuid; st text;
BEGIN
  s := public.sdf_lock_leased(_step, _lease);
  IF s.block_key = 'B01' THEN
    FOR x IN SELECT value FROM jsonb_array_elements(COALESCE(_result->'tags','[]'::jsonb)) LOOP
      UPDATE public.source_segments SET tags = x->'tags', speaker = COALESCE(NULLIF(x->>'speaker',''), speaker) WHERE id = (x->>'segment_id')::uuid AND app_id = s.app_id;
    END LOOP;
  ELSIF s.block_key = 'B02' THEN
    FOR x IN SELECT value FROM jsonb_array_elements(COALESCE(_result->'requirements','[]'::jsonb)) LOOP
      PERFORM public.sdf_upsert_requirement(s.app_id, x, _step, NULL, '需求整理生成');
    END LOOP;
  ELSIF s.block_key = 'B03' THEN
    UPDATE public.analysis_findings SET status = 'stale' WHERE app_id = s.app_id AND status = 'open';
    FOR x IN SELECT value FROM jsonb_array_elements(COALESCE(_result->'findings','[]'::jsonb)) LOOP
      INSERT INTO public.analysis_findings(code, app_id, run_id, step_run_id, severity, category, target_refs, description, suggestion, rule_or_agent)
      VALUES (public.next_code(s.app_id,'F'), s.app_id, s.run_id, _step, x->>'severity', x->>'category', COALESCE(x->'target_refs','[]'::jsonb), x->>'description', COALESCE(x->>'suggestion',''), x->>'rule_or_agent');
    END LOOP;
  ELSIF s.block_key = 'B04' THEN
    UPDATE public.clarification_questions SET status = 'stale' WHERE app_id = s.app_id AND status = 'open';
    FOR x IN SELECT value FROM jsonb_array_elements(COALESCE(_result->'questions','[]'::jsonb)) LOOP
      INSERT INTO public.clarification_questions(code, app_id, step_run_id, stakeholder, contact_id, question, target_refs)
      VALUES (public.next_code(s.app_id,'Q'), s.app_id, _step, x->>'stakeholder', NULLIF(x->>'contact_id','')::uuid, x->>'question', x->'target_refs');
    END LOOP;
  END IF;
  IF _result ? 'artifact' THEN
    aid := public.sdf_write_artifact(s.app_id, _result->'artifact', _step, NULL, 'agent');
    outs := jsonb_build_array(aid::text);
    PERFORM public.sdf_event(_step, 'artifact', '生成制品：' || COALESCE(_result->'artifact'->>'title',''), jsonb_build_object('artifact_id', aid));
  END IF;
  st := CASE WHEN COALESCE(s.checkpoint ? 'role', false) THEN 'waiting_human' ELSE 'succeeded' END;
  UPDATE public.step_runs SET status = st, summary = left(_summary, 2000), output_artifacts = outs, lease_token = NULL, lease_expires_at = NULL,
    progress_text = NULL, finished_at = CASE WHEN st = 'succeeded' THEN now() ELSE NULL END,
    tokens = tokens + COALESCE((_result->>'tokens')::integer,0), model_calls = model_calls + COALESCE((_result->>'calls')::integer,0) WHERE id = _step;
  PERFORM public.sdf_event(_step, CASE WHEN st='waiting_human' THEN 'human' ELSE 'status' END, CASE WHEN st = 'waiting_human' THEN '等待确认：' || COALESCE(s.checkpoint->>'role','lead') ELSE '执行完成' END);
  PERFORM public.sdf_refresh_run(s.run_id);
  RETURN st;
END $$;
REVOKE EXECUTE ON FUNCTION public.merge_step_results(uuid,uuid,jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_step_results(uuid,uuid,jsonb,text) TO service_role;