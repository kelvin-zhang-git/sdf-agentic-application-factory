CREATE OR REPLACE FUNCTION public.sdf_event(_step uuid, _kind text, _msg text, _data jsonb DEFAULT '{}'::jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.step_events(step_run_id, app_id, kind, message, data)
  SELECT s.id, s.app_id, _kind, left(_msg, 2000), COALESCE(_data, '{}'::jsonb) FROM public.step_runs s WHERE s.id = _step;
$$;

CREATE OR REPLACE FUNCTION public.sdf_refresh_run(_run uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.workflow_runs; st text; cur text;
BEGIN
  SELECT * INTO r FROM public.workflow_runs WHERE id = _run FOR UPDATE;
  IF r.status = 'cancelled' THEN RETURN r.status; END IF;
  SELECT step_key INTO cur FROM public.step_runs WHERE run_id = _run AND is_current AND status NOT IN ('succeeded','skipped') ORDER BY seq LIMIT 1;
  st := CASE
    WHEN EXISTS (SELECT 1 FROM public.step_runs WHERE run_id=_run AND is_current AND status='waiting_human') THEN 'waiting_human'
    WHEN EXISTS (SELECT 1 FROM public.step_runs WHERE run_id=_run AND is_current AND status='waiting_model') THEN 'waiting_model'
    WHEN EXISTS (SELECT 1 FROM public.step_runs WHERE run_id=_run AND is_current AND status='failed') THEN 'failed'
    WHEN cur IS NULL THEN 'completed' ELSE 'running' END;
  UPDATE public.workflow_runs SET status = st, current_step_key = cur, lock_version = lock_version + 1,
    finished_at = CASE WHEN st = 'completed' THEN now() ELSE NULL END WHERE id = _run;
  RETURN st;
END $$;

CREATE OR REPLACE FUNCTION public.sdf_audit(_actor uuid, _app uuid, _action text, _ttype text, _tid text, _trace text, _detail jsonb DEFAULT '{}'::jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.audit_logs(trace_id, actor_id, app_id, action, target_type, target_id, detail) VALUES (_trace, _actor, _app, _action, _ttype, _tid, COALESCE(_detail,'{}'::jsonb));
$$;

CREATE OR REPLACE FUNCTION public.start_run(_app uuid, _workflow uuid, _weight text, _inputs jsonb, _actor uuid, _trace text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE w public.workflows; rid uuid; s jsonb; i integer; cp jsonb;
BEGIN
  SELECT * INTO w FROM public.workflows WHERE id = _workflow;
  IF NOT FOUND OR NOT w.startable THEN RAISE EXCEPTION 'SDF_VALIDATION: workflow not startable'; END IF;
  IF _weight NOT IN ('light','standard','full') THEN RAISE EXCEPTION 'SDF_VALIDATION: weight'; END IF;
  INSERT INTO public.workflow_runs(code, app_id, workflow_id, workflow_snapshot, weight, inputs, started_by, trace_id)
  VALUES (public.next_code(_app, 'R'), _app, _workflow, w.definition, _weight, COALESCE(_inputs,'{}'::jsonb), _actor, _trace) RETURNING id INTO rid;
  FOR s, i IN SELECT e.value, e.ordinality FROM jsonb_array_elements(w.definition->'steps') WITH ORDINALITY e LOOP
    cp := s->'checkpoints'->_weight;
    INSERT INTO public.step_runs(run_id, app_id, step_key, stage, block_key, seq, status, checkpoint, skip_reason, finished_at)
    VALUES (rid, _app, s->>'key', s->>'stage', s->>'block', i::integer,
      CASE WHEN s->'weights' ? _weight THEN 'pending' ELSE 'skipped' END,
      CASE WHEN cp IS NULL OR cp = 'null'::jsonb THEN NULL ELSE cp END,
      CASE WHEN s->'weights' ? _weight THEN NULL ELSE '当前档位不执行' END,
      CASE WHEN s->'weights' ? _weight THEN NULL ELSE now() END);
  END LOOP;
  PERFORM public.sdf_refresh_run(rid);
  PERFORM public.sdf_audit(_actor, _app, 'run.started', 'workflow_run', rid::text, _trace, jsonb_build_object('workflow', w.key, 'version', w.version, 'weight', _weight));
  RETURN rid;
END $$;

CREATE OR REPLACE FUNCTION public.claim_step(_run uuid, _lease_seconds integer) RETURNS TABLE(step_run_id uuid, lease_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE sid uuid; tok uuid := gen_random_uuid(); was text;
BEGIN
  SELECT s.id, s.status INTO sid, was FROM public.step_runs s JOIN public.workflow_runs r ON r.id = s.run_id
  WHERE s.is_current AND r.status = 'running' AND (_run IS NULL OR s.run_id = _run)
    AND ((s.status = 'pending' AND s.seq = (SELECT min(x.seq) FROM public.step_runs x WHERE x.run_id = s.run_id AND x.is_current AND x.status NOT IN ('succeeded','skipped')))
      OR (s.status = 'running' AND s.lease_expires_at < now()))
  ORDER BY s.created_at LIMIT 1 FOR UPDATE OF s SKIP LOCKED;
  IF sid IS NULL THEN RETURN; END IF;
  UPDATE public.step_runs SET status = 'running', lease_token = tok, lease_expires_at = now() + make_interval(secs => _lease_seconds),
    heartbeat_at = now(), started_at = COALESCE(started_at, now()) WHERE id = sid;
  PERFORM public.sdf_event(sid, 'status', CASE WHEN was = 'running' THEN '从断点继续执行' ELSE '开始执行' END);
  step_run_id := sid; lease_token := tok; RETURN NEXT;
END $$;

CREATE OR REPLACE FUNCTION public.sdf_lock_leased(_step uuid, _lease uuid) RETURNS public.step_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.step_runs;
BEGIN
  SELECT * INTO s FROM public.step_runs WHERE id = _step FOR UPDATE;
  IF NOT FOUND OR s.status <> 'running' OR s.lease_token IS DISTINCT FROM _lease THEN RAISE EXCEPTION 'SDF_LEASE_LOST'; END IF;
  RETURN s;
END $$;

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
  UPDATE public.step_runs SET heartbeat_at = now(), lease_expires_at = CASE WHEN _release THEN now() ELSE now() + interval '60 seconds' END WHERE id = _step;
  RETURN n = 1;
END $$;

CREATE OR REPLACE FUNCTION public.heartbeat_step(_step uuid, _lease uuid, _progress text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.sdf_lock_leased(_step, _lease);
  UPDATE public.step_runs SET heartbeat_at = now(), lease_expires_at = now() + interval '60 seconds', progress_text = COALESCE(left(_progress,500), progress_text) WHERE id = _step;
END $$;

CREATE OR REPLACE FUNCTION public.get_step_chunks(_step uuid) RETURNS TABLE(cursor_seq integer, payload jsonb)
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT c.cursor_seq, c.payload FROM public.step_chunk_results c JOIN public.step_runs s ON s.id = c.step_run_id AND s.attempt = c.attempt
  WHERE c.step_run_id = _step ORDER BY c.cursor_seq;
$$;

CREATE OR REPLACE FUNCTION public.sdf_write_artifact(_app uuid, _a jsonb, _step uuid, _actor uuid, _source text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v integer; aid uuid;
BEGIN
  SELECT COALESCE(max(version),0) + 1 INTO v FROM public.artifacts WHERE app_id = _app AND type = _a->>'type' AND key = _a->>'key';
  UPDATE public.artifacts SET is_latest = false WHERE app_id = _app AND type = _a->>'type' AND key = _a->>'key' AND is_latest;
  INSERT INTO public.artifacts(app_id, type, key, version, title, content, content_json, status, is_latest, step_run_id, source, agent_role, model, confidence, citations, created_by)
  VALUES (_app, _a->>'type', _a->>'key', v, COALESCE(_a->>'title', _a->>'type'), COALESCE(_a->>'content',''), _a->'content_json', 'draft', true, _step, _source,
    _a->>'agent_role', _a->>'model', (_a->>'confidence')::numeric, COALESCE(_a->'citations','[]'::jsonb), _actor) RETURNING id INTO aid;
  RETURN aid;
END $$;

CREATE OR REPLACE FUNCTION public.sdf_upsert_requirement(_app uuid, _q jsonb, _step uuid, _actor uuid, _reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE rid uuid; ver integer; c jsonb;
BEGIN
  SELECT id INTO rid FROM public.requirements WHERE app_id = _app AND status <> 'deprecated' AND lower(title) = lower(_q->>'title') LIMIT 1 FOR UPDATE;
  IF rid IS NULL THEN
    INSERT INTO public.requirements(code, app_id, title, story, type, priority, confidence, citations)
    VALUES (public.next_code(_app,'REQ'), _app, _q->>'title', COALESCE(_q->>'story',''), COALESCE(_q->>'type','functional'), COALESCE(_q->>'priority','should'), (_q->>'confidence')::numeric, _q->'citations')
    RETURNING id, current_version INTO rid, ver;
  ELSE
    UPDATE public.requirements SET story = COALESCE(_q->>'story', story), type = COALESCE(_q->>'type', type), priority = COALESCE(_q->>'priority', priority),
      confidence = COALESCE((_q->>'confidence')::numeric, confidence), citations = COALESCE(_q->'citations', citations), current_version = current_version + 1,
      possibly_stale = false, updated_at = now() WHERE id = rid RETURNING current_version INTO ver;
  END IF;
  FOR c IN SELECT value FROM jsonb_array_elements(COALESCE(_q->'criteria','[]'::jsonb)) LOOP
    INSERT INTO public.acceptance_criteria(code, requirement_id, app_id, format, text, requirement_version)
    VALUES (public.next_code(_app,'AC'), rid, _app, COALESCE(c->>'format','gwt'), c->>'text', ver);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM public.acceptance_criteria WHERE requirement_id = rid AND requirement_version = ver) THEN
    INSERT INTO public.acceptance_criteria(code, requirement_id, app_id, format, text, requirement_version)
    SELECT public.next_code(_app,'AC'), rid, _app, a.format, a.text, ver FROM public.acceptance_criteria a
    WHERE a.requirement_id = rid AND a.requirement_version = ver - 1;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.acceptance_criteria WHERE requirement_id = rid AND requirement_version = ver) THEN RAISE EXCEPTION 'SDF_VALIDATION: requirement needs acceptance criteria'; END IF;
  INSERT INTO public.requirement_versions(requirement_id, app_id, version, snapshot, change_reason, step_run_id, changed_by)
  SELECT r.id, r.app_id, r.current_version, to_jsonb(r) || jsonb_build_object('criteria', (SELECT COALESCE(jsonb_agg(jsonb_build_object('code',a.code,'format',a.format,'text',a.text) ORDER BY a.code),'[]'::jsonb) FROM public.acceptance_criteria a WHERE a.requirement_id = r.id AND a.requirement_version = r.current_version)),
    _reason, _step, _actor FROM public.requirements r WHERE r.id = rid;
  RETURN rid;
END $$;

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
  st := CASE WHEN s.checkpoint IS NOT NULL THEN 'waiting_human' ELSE 'succeeded' END;
  UPDATE public.step_runs SET status = st, summary = left(_summary, 2000), output_artifacts = outs, lease_token = NULL, lease_expires_at = NULL,
    progress_text = NULL, finished_at = CASE WHEN st = 'succeeded' THEN now() ELSE NULL END,
    tokens = tokens + COALESCE((_result->>'tokens')::integer,0), model_calls = model_calls + COALESCE((_result->>'calls')::integer,0) WHERE id = _step;
  PERFORM public.sdf_event(_step, CASE WHEN st='waiting_human' THEN 'human' ELSE 'status' END, CASE WHEN st = 'waiting_human' THEN '等待确认：' || COALESCE(s.checkpoint->>'role','lead') ELSE '执行完成' END);
  PERFORM public.sdf_refresh_run(s.run_id);
  RETURN st;
END $$;

CREATE OR REPLACE FUNCTION public.wait_step_model(_step uuid, _lease uuid, _reason text, _error jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.step_runs;
BEGIN
  s := public.sdf_lock_leased(_step, _lease);
  UPDATE public.step_runs SET status = 'waiting_model', wait_reason = _reason, error = _error, lease_token = NULL, lease_expires_at = NULL,
    next_retry_at = CASE WHEN _reason = 'model_not_configured' THEN NULL ELSE now() + interval '5 minutes' END WHERE id = _step;
  PERFORM public.sdf_event(_step, 'error', CASE _reason WHEN 'model_not_configured' THEN '需要配置模型' WHEN 'rate_limited' THEN '模型限流，5 分钟后重试' ELSE '模型暂不可用，5 分钟后重试' END, COALESCE(_error,'{}'::jsonb));
  PERFORM public.sdf_refresh_run(s.run_id);
END $$;

CREATE OR REPLACE FUNCTION public.fail_step(_step uuid, _lease uuid, _error jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.step_runs;
BEGIN
  s := public.sdf_lock_leased(_step, _lease);
  UPDATE public.step_runs SET status = 'failed', error = _error, lease_token = NULL, lease_expires_at = NULL, finished_at = now() WHERE id = _step;
  PERFORM public.sdf_event(_step, 'error', COALESCE(_error->>'message','执行失败'), COALESCE(_error,'{}'::jsonb));
  PERFORM public.sdf_refresh_run(s.run_id);
END $$;

CREATE OR REPLACE FUNCTION public.sdf_retire_outputs(_steps uuid[]) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE public.artifacts SET status = 'superseded' WHERE step_run_id = ANY(_steps) AND status = 'draft';
  UPDATE public.analysis_findings SET status = 'stale' WHERE step_run_id = ANY(_steps) AND status = 'open';
  UPDATE public.clarification_questions SET status = 'stale' WHERE step_run_id = ANY(_steps) AND status = 'open';
$$;

CREATE OR REPLACE FUNCTION public.sdf_requeue(_run uuid, _from integer, _to integer, _feedback text, _goto text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.step_runs; ids uuid[] := '{}';
BEGIN
  FOR o IN SELECT * FROM public.step_runs WHERE run_id = _run AND is_current AND seq BETWEEN _from AND _to AND COALESCE(skip_reason,'') <> '当前档位不执行' ORDER BY seq FOR UPDATE LOOP
    IF o.status = 'running' THEN RAISE EXCEPTION 'SDF_CONFLICT: step running'; END IF;
    UPDATE public.step_runs SET is_current = false,
      status = CASE WHEN status IN ('succeeded','waiting_human','pending','skipped') THEN 'superseded' ELSE status END,
      wait_reason = CASE WHEN status IN ('succeeded','waiting_human','pending','skipped') THEN NULL ELSE wait_reason END,
      finished_at = COALESCE(finished_at, now()) WHERE id = o.id;
    ids := ids || o.id;
    INSERT INTO public.step_runs(run_id, app_id, step_key, stage, block_key, seq, attempt, checkpoint, input_artifacts)
    VALUES (_run, o.app_id, o.step_key, o.stage, o.block_key, o.seq, (SELECT max(attempt)+1 FROM public.step_runs WHERE run_id=_run AND step_key=o.step_key),
      CASE WHEN o.step_key = _goto AND _feedback IS NOT NULL THEN COALESCE(o.checkpoint,'{}'::jsonb) || jsonb_build_object('feedback', _feedback) ELSE o.checkpoint - 'feedback' END,
      o.input_artifacts);
  END LOOP;
  PERFORM public.sdf_retire_outputs(ids);
END $$;

CREATE OR REPLACE FUNCTION public.decide_step(_step uuid, _actor uuid, _decision text, _comment text, _goto text, _trace text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.step_runs; g public.step_runs;
BEGIN
  SELECT * INTO s FROM public.step_runs WHERE id = _step;
  IF NOT FOUND THEN RAISE EXCEPTION 'SDF_NOT_FOUND'; END IF;
  PERFORM 1 FROM public.workflow_runs WHERE id = s.run_id FOR UPDATE;
  SELECT * INTO s FROM public.step_runs WHERE id = _step FOR UPDATE;
  IF s.status <> 'waiting_human' OR NOT s.is_current THEN RAISE EXCEPTION 'SDF_CONFLICT: step already decided'; END IF;
  IF _decision = 'approve' THEN
    IF s.block_key = 'B03' AND EXISTS (SELECT 1 FROM public.analysis_findings WHERE step_run_id = _step AND severity = 'blocker' AND status = 'open') THEN
      RAISE EXCEPTION 'SDF_BLOCKERS_OPEN'; END IF;
    UPDATE public.step_runs SET status = 'succeeded', decision = 'approve', decided_by = _actor, decision_comment = _comment, finished_at = now() WHERE id = _step;
    PERFORM public.sdf_event(_step, 'human', '确认通过', jsonb_build_object('comment', _comment));
  ELSIF _decision = 'reject' THEN
    IF COALESCE(trim(_comment),'') = '' THEN RAISE EXCEPTION 'SDF_VALIDATION: reject needs comment'; END IF;
    SELECT * INTO g FROM public.step_runs WHERE run_id = s.run_id AND is_current AND step_key = COALESCE(_goto, s.step_key);
    IF NOT FOUND OR g.seq > s.seq OR (g.status = 'skipped' AND g.skip_reason = '当前档位不执行') THEN RAISE EXCEPTION 'SDF_VALIDATION: invalid goto'; END IF;
    UPDATE public.step_runs SET status = 'rejected', decision = 'reject', decided_by = _actor, decision_comment = _comment, reject_goto = g.step_key, finished_at = now() WHERE id = _step;
    PERFORM public.sdf_event(_step, 'human', '退回到 ' || g.step_key, jsonb_build_object('comment', _comment));
    PERFORM public.sdf_requeue(s.run_id, g.seq, s.seq, _comment, g.step_key);
  ELSE RAISE EXCEPTION 'SDF_VALIDATION: decision'; END IF;
  PERFORM public.sdf_audit(_actor, s.app_id, 'step.' || _decision, 'step_run', _step::text, _trace, jsonb_build_object('goto', _goto));
  RETURN public.sdf_refresh_run(s.run_id);
END $$;

CREATE OR REPLACE FUNCTION public.retry_step(_step uuid, _actor uuid, _trace text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.step_runs;
BEGIN
  SELECT * INTO s FROM public.step_runs WHERE id = _step;
  IF NOT FOUND THEN RAISE EXCEPTION 'SDF_NOT_FOUND'; END IF;
  PERFORM 1 FROM public.workflow_runs WHERE id = s.run_id AND status <> 'cancelled' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SDF_CONFLICT: run cancelled'; END IF;
  SELECT * INTO s FROM public.step_runs WHERE id = _step FOR UPDATE;
  IF NOT s.is_current OR s.status NOT IN ('failed','waiting_model') THEN RAISE EXCEPTION 'SDF_CONFLICT: step not retryable'; END IF;
  UPDATE public.step_runs SET is_current = false, finished_at = COALESCE(finished_at, now()) WHERE id = _step;
  INSERT INTO public.step_runs(run_id, app_id, step_key, stage, block_key, seq, attempt, checkpoint, input_artifacts)
  VALUES (s.run_id, s.app_id, s.step_key, s.stage, s.block_key, s.seq, s.attempt + 1, s.checkpoint, s.input_artifacts);
  PERFORM public.sdf_event(_step, 'status', '手动重试，新建第 ' || (s.attempt + 1) || ' 次执行');
  PERFORM public.sdf_audit(_actor, s.app_id, 'step.retry', 'step_run', _step::text, _trace, '{}'::jsonb);
  RETURN public.sdf_refresh_run(s.run_id);
END $$;

CREATE OR REPLACE FUNCTION public.skip_step(_step uuid, _actor uuid, _reason text, _trace text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.step_runs;
BEGIN
  IF COALESCE(trim(_reason),'') = '' THEN RAISE EXCEPTION 'SDF_VALIDATION: skip reason'; END IF;
  SELECT * INTO s FROM public.step_runs WHERE id = _step;
  IF NOT FOUND THEN RAISE EXCEPTION 'SDF_NOT_FOUND'; END IF;
  PERFORM 1 FROM public.workflow_runs WHERE id = s.run_id FOR UPDATE;
  SELECT * INTO s FROM public.step_runs WHERE id = _step FOR UPDATE;
  IF NOT s.is_current OR s.status NOT IN ('pending','failed','waiting_model') THEN RAISE EXCEPTION 'SDF_CONFLICT: step not skippable'; END IF;
  UPDATE public.step_runs SET status = 'skipped', wait_reason = NULL, skip_reason = left(_reason, 500), finished_at = now() WHERE id = _step;
  PERFORM public.sdf_event(_step, 'human', '负责人跳过：' || left(_reason, 200));
  PERFORM public.sdf_audit(_actor, s.app_id, 'step.skipped', 'step_run', _step::text, _trace, jsonb_build_object('reason', left(_reason,500)));
  RETURN public.sdf_refresh_run(s.run_id);
END $$;

CREATE OR REPLACE FUNCTION public.cancel_run(_run uuid, _actor uuid, _trace text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.workflow_runs;
BEGIN
  SELECT * INTO r FROM public.workflow_runs WHERE id = _run FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SDF_NOT_FOUND'; END IF;
  IF r.status IN ('completed','cancelled') THEN RAISE EXCEPTION 'SDF_CONFLICT: run finished'; END IF;
  UPDATE public.step_runs SET status = 'cancelled', wait_reason = NULL, lease_token = NULL, lease_expires_at = NULL, finished_at = now()
  WHERE run_id = _run AND is_current AND status IN ('pending','running','waiting_human','waiting_event','waiting_model');
  UPDATE public.workflow_runs SET status = 'cancelled', finished_at = now(), lock_version = lock_version + 1 WHERE id = _run;
  PERFORM public.sdf_audit(_actor, r.app_id, 'run.cancelled', 'workflow_run', _run::text, _trace, '{}'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.rerun_from(_run uuid, _step_key text, _actor uuid, _trace text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.workflow_runs; t public.step_runs;
BEGIN
  SELECT * INTO r FROM public.workflow_runs WHERE id = _run FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SDF_NOT_FOUND'; END IF;
  IF r.status = 'cancelled' THEN RAISE EXCEPTION 'SDF_CONFLICT: run cancelled'; END IF;
  SELECT * INTO t FROM public.step_runs WHERE run_id = _run AND is_current AND step_key = _step_key;
  IF NOT FOUND OR t.skip_reason = '当前档位不执行' THEN RAISE EXCEPTION 'SDF_VALIDATION: invalid step'; END IF;
  PERFORM public.sdf_requeue(_run, t.seq, 100000, NULL, NULL);
  UPDATE public.workflow_runs SET status = 'running', finished_at = NULL WHERE id = _run;
  PERFORM public.sdf_audit(_actor, r.app_id, 'run.rerun', 'workflow_run', _run::text, _trace, jsonb_build_object('from', _step_key));
  RETURN public.sdf_refresh_run(_run);
END $$;

CREATE OR REPLACE FUNCTION public.edit_requirement(_req uuid, _actor uuid, _patch jsonb, _reason text, _trace text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.requirements; q jsonb; v integer;
BEGIN
  SELECT * INTO r FROM public.requirements WHERE id = _req FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SDF_NOT_FOUND'; END IF;
  IF COALESCE(trim(_reason),'') = '' THEN RAISE EXCEPTION 'SDF_VALIDATION: change reason'; END IF;
  q := jsonb_build_object('title', r.title) || (COALESCE(_patch,'{}'::jsonb) - 'title' - 'citations');
  PERFORM public.sdf_upsert_requirement(r.app_id, q, NULL, _actor, left(_reason, 500));
  IF _patch ? 'status' THEN UPDATE public.requirements SET status = _patch->>'status' WHERE id = _req; END IF;
  SELECT current_version INTO v FROM public.requirements WHERE id = _req;
  UPDATE public.artifacts SET possibly_stale = true WHERE app_id = r.app_id AND is_latest AND type IN ('requirements','analysis','clarifications');
  PERFORM public.sdf_audit(_actor, r.app_id, 'requirement.edited', 'requirement', _req::text, _trace, jsonb_build_object('version', v, 'reason', left(_reason,500)));
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.edit_artifact(_app uuid, _actor uuid, _a jsonb, _trace text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE aid uuid;
BEGIN
  IF _a->>'type' NOT IN ('constitution') THEN RAISE EXCEPTION 'SDF_VALIDATION: artifact type not editable'; END IF;
  aid := public.sdf_write_artifact(_app, _a, NULL, _actor, 'human');
  PERFORM public.sdf_audit(_actor, _app, 'artifact.edited', 'artifact', aid::text, _trace, jsonb_build_object('type', _a->>'type', 'key', _a->>'key'));
  RETURN aid;
END $$;

CREATE OR REPLACE FUNCTION public.write_source_segments(_source uuid, _raw text, _segments jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE src public.sources; n integer;
BEGIN
  SELECT * INTO src FROM public.sources WHERE id = _source FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SDF_NOT_FOUND'; END IF;
  n := jsonb_array_length(_segments);
  IF n = 0 OR n > 2000 THEN RAISE EXCEPTION 'SDF_VALIDATION: segment count'; END IF;
  DELETE FROM public.source_segments WHERE source_id = _source;
  INSERT INTO public.source_segments(source_id, app_id, seq, speaker, text)
  SELECT _source, src.app_id, e.ordinality::integer, NULLIF(e.value->>'speaker',''), e.value->>'text' FROM jsonb_array_elements(_segments) WITH ORDINALITY e;
  UPDATE public.sources SET raw_text = _raw, parse_status = 'parsed', parse_error = NULL WHERE id = _source;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.mark_source_failed(_source uuid, _error text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE public.sources SET parse_status = 'failed', parse_error = left(_error, 500) WHERE id = _source;
$$;

CREATE OR REPLACE FUNCTION public.sdf_engine_sweep() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.step_runs; stalled integer := 0; retried integer := 0;
BEGIN
  FOR s IN SELECT * FROM public.step_runs WHERE status = 'running' AND heartbeat_at < now() - interval '5 minutes' FOR UPDATE SKIP LOCKED LOOP
    UPDATE public.step_runs SET status = 'failed', lease_token = NULL, lease_expires_at = NULL, finished_at = now(),
      error = jsonb_build_object('code','STEP_STALLED','message','步骤超过 5 分钟没有心跳，已标记失败，可重试') WHERE id = s.id;
    PERFORM public.sdf_event(s.id, 'error', '步骤超过 5 分钟没有心跳，已标记失败');
    PERFORM public.sdf_refresh_run(s.run_id); stalled := stalled + 1;
  END LOOP;
  FOR s IN SELECT * FROM public.step_runs WHERE status = 'waiting_model' AND is_current AND wait_reason IN ('model_unavailable','rate_limited') AND next_retry_at <= now() FOR UPDATE SKIP LOCKED LOOP
    IF s.retry_count >= 12 THEN
      UPDATE public.step_runs SET status = 'failed', wait_reason = NULL, finished_at = now(), error = jsonb_build_object('code','LLM_RETRY_EXHAUSTED','message','模型连续 12 次不可用，已停止自动重试') WHERE id = s.id;
      PERFORM public.sdf_event(s.id, 'error', '自动重试 12 次仍失败');
    ELSE
      UPDATE public.step_runs SET status = 'pending', wait_reason = NULL, next_retry_at = NULL, retry_count = retry_count + 1 WHERE id = s.id;
      PERFORM public.sdf_event(s.id, 'status', '第 ' || (s.retry_count + 1) || ' 次自动重试');
    END IF;
    PERFORM public.sdf_refresh_run(s.run_id); retried := retried + 1;
  END LOOP;
  RETURN jsonb_build_object('stalled', stalled, 'retried', retried);
END $$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['sdf_event(uuid,text,text,jsonb)','sdf_refresh_run(uuid)','sdf_audit(uuid,uuid,text,text,text,text,jsonb)','start_run(uuid,uuid,text,jsonb,uuid,text)',
   'claim_step(uuid,integer)','sdf_lock_leased(uuid,uuid)','save_step_chunk(uuid,uuid,integer,jsonb,jsonb,text,integer,integer,boolean)','heartbeat_step(uuid,uuid,text)',
   'get_step_chunks(uuid)','sdf_write_artifact(uuid,jsonb,uuid,uuid,text)','sdf_upsert_requirement(uuid,jsonb,uuid,uuid,text)','merge_step_results(uuid,uuid,jsonb,text)',
   'wait_step_model(uuid,uuid,text,jsonb)','fail_step(uuid,uuid,jsonb)','sdf_retire_outputs(uuid[])','sdf_requeue(uuid,integer,integer,text,text)',
   'decide_step(uuid,uuid,text,text,text,text)','retry_step(uuid,uuid,text)','skip_step(uuid,uuid,text,text)','cancel_run(uuid,uuid,text)','rerun_from(uuid,text,uuid,text)',
   'edit_requirement(uuid,uuid,jsonb,text,text)','edit_artifact(uuid,uuid,jsonb,text)','write_source_segments(uuid,text,jsonb)','mark_source_failed(uuid,text)',
   'sdf_engine_sweep()'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;