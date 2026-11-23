-- 阶段 7：积木可停用、未实施目录改成正式名称、只清理澄远失败运行。
ALTER TABLE public.example_catalog ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;

UPDATE public.example_catalog SET name = '问题诊断与 RCA' WHERE id = 'B25' AND kind = 'block';
UPDATE public.example_catalog SET name = '知识检索问答' WHERE id = 'B27' AND kind = 'block';
UPDATE public.example_catalog SET name = '交付流度量' WHERE id = 'B30' AND kind = 'block';

BEGIN;

CREATE TEMP TABLE doomed_runs AS
SELECT r.id
FROM public.workflow_runs r
JOIN public.apps a ON a.id = r.app_id
WHERE a.name = '澄远零售门店智能补货'
  AND r.code IN ('R-0003', 'R-0004', 'R-0005')
  AND r.status = 'failed';

UPDATE public.tasks
SET created_by_step = NULL
WHERE created_by_step IN (SELECT s.id FROM public.step_runs s WHERE s.run_id IN (SELECT id FROM doomed_runs));

UPDATE public.test_cases
SET created_by_step = NULL
WHERE created_by_step IN (SELECT s.id FROM public.step_runs s WHERE s.run_id IN (SELECT id FROM doomed_runs));

DELETE FROM public.workflow_runs WHERE id IN (SELECT id FROM doomed_runs);

COMMIT;

CREATE OR REPLACE FUNCTION public.start_run(_app uuid, _workflow uuid, _weight text, _inputs jsonb, _actor uuid, _trace text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE w public.workflows; rid uuid; s jsonb; i integer; cp jsonb;
  weight_skip boolean; yaml_skip boolean; disabled boolean; planned_skip boolean;
BEGIN
  SELECT * INTO w FROM public.workflows WHERE id = _workflow;
  IF NOT FOUND OR NOT w.startable THEN RAISE EXCEPTION 'SDF_VALIDATION: workflow not startable'; END IF;
  IF _weight NOT IN ('light','standard','full') THEN RAISE EXCEPTION 'SDF_VALIDATION: weight'; END IF;
  INSERT INTO public.workflow_runs(code, app_id, workflow_id, workflow_snapshot, weight, inputs, started_by, trace_id)
  VALUES (public.next_code(_app, 'R'), _app, _workflow, w.definition, _weight, COALESCE(_inputs,'{}'::jsonb), _actor, _trace) RETURNING id INTO rid;
  FOR s, i IN SELECT e.value, e.ordinality FROM jsonb_array_elements(w.definition->'steps') WITH ORDINALITY e LOOP
    cp := s->'checkpoints'->_weight;
    weight_skip := NOT (s->'weights' ? _weight);
    yaml_skip := COALESCE((s->>'skip')::boolean, false);
    disabled := EXISTS (
      SELECT 1 FROM public.example_catalog c
      WHERE c.kind = 'block' AND c.id = s->>'block' AND c.enabled = false
    );
    planned_skip := weight_skip OR yaml_skip OR disabled;
    INSERT INTO public.step_runs(run_id, app_id, step_key, stage, block_key, seq, status, checkpoint, skip_reason, finished_at)
    VALUES (rid, _app, s->>'key', s->>'stage', s->>'block', i::integer,
      CASE WHEN planned_skip THEN 'skipped' ELSE 'pending' END,
      CASE WHEN cp IS NULL OR cp = 'null'::jsonb THEN NULL ELSE cp END,
      CASE
        WHEN weight_skip THEN '当前档位不执行'
        WHEN yaml_skip THEN '本阶段规划跳过'
        WHEN disabled THEN '积木已停用'
        ELSE NULL
      END,
      CASE WHEN planned_skip THEN now() ELSE NULL END);
  END LOOP;
  PERFORM public.sdf_refresh_run(rid);
  PERFORM public.sdf_audit(_actor, _app, 'run.started', 'workflow_run', rid::text, _trace, jsonb_build_object('workflow', w.key, 'version', w.version, 'weight', _weight));
  RETURN rid;
END $$;
