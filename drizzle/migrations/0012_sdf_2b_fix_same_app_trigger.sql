CREATE OR REPLACE FUNCTION public.sdf_check_same_app() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE bad integer;
BEGIN
  IF TG_TABLE_NAME = 'source_segments' THEN
    IF NOT EXISTS (SELECT 1 FROM public.sources s WHERE s.id = NEW.source_id AND s.app_id = NEW.app_id) THEN RAISE EXCEPTION 'SDF_REF_CROSS_APP: source'; END IF;
  ELSIF TG_TABLE_NAME = 'acceptance_criteria' OR TG_TABLE_NAME = 'requirement_versions' THEN
    IF NOT EXISTS (SELECT 1 FROM public.requirements r WHERE r.id = NEW.requirement_id AND r.app_id = NEW.app_id) THEN RAISE EXCEPTION 'SDF_REF_CROSS_APP: requirement'; END IF;
  ELSIF TG_TABLE_NAME = 'step_runs' THEN
    IF NOT EXISTS (SELECT 1 FROM public.workflow_runs w WHERE w.id = NEW.run_id AND w.app_id = NEW.app_id) THEN RAISE EXCEPTION 'SDF_REF_CROSS_APP: run'; END IF;
  ELSIF TG_TABLE_NAME = 'step_events' THEN
    IF NOT EXISTS (SELECT 1 FROM public.step_runs w WHERE w.id = NEW.step_run_id AND w.app_id = NEW.app_id) THEN RAISE EXCEPTION 'SDF_REF_CROSS_APP: step'; END IF;
  ELSIF TG_TABLE_NAME = 'requirements' THEN
    SELECT count(*) INTO bad FROM jsonb_array_elements(NEW.citations) c
      WHERE NOT EXISTS (SELECT 1 FROM public.source_segments g WHERE g.id::text = c->>'segment_id' AND g.app_id = NEW.app_id);
    IF bad > 0 THEN RAISE EXCEPTION 'SDF_REF_CROSS_APP: citation'; END IF;
  ELSIF TG_TABLE_NAME IN ('analysis_findings','clarification_questions') THEN
    IF TG_TABLE_NAME = 'clarification_questions' THEN
      IF (to_jsonb(NEW)->>'contact_id') IS NOT NULL AND NOT EXISTS
        (SELECT 1 FROM public.app_contacts ac WHERE ac.contact_id = (to_jsonb(NEW)->>'contact_id')::uuid AND ac.app_id = NEW.app_id) THEN RAISE EXCEPTION 'SDF_REF_CROSS_APP: contact'; END IF;
    END IF;
    SELECT count(*) INTO bad FROM jsonb_array_elements(NEW.target_refs) t WHERE NOT (
      (t->>'type' = 'requirement' AND EXISTS (SELECT 1 FROM public.requirements r WHERE r.id::text = t->>'id' AND r.app_id = NEW.app_id)) OR
      (t->>'type' = 'finding' AND EXISTS (SELECT 1 FROM public.analysis_findings f WHERE f.id::text = t->>'id' AND f.app_id = NEW.app_id)));
    IF bad > 0 THEN RAISE EXCEPTION 'SDF_REF_CROSS_APP: target_ref'; END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.sdf_check_same_app() FROM PUBLIC, anon, authenticated;