-- 任务归属功能，交付检查可以记下版本。

ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS feature_id uuid REFERENCES public.features(id) ON DELETE SET NULL;
ALTER TABLE public.gate_results ADD COLUMN IF NOT EXISTS iteration_id uuid;

CREATE OR REPLACE FUNCTION public.tasks_fill_feature() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.feature_id IS NULL AND NEW.created_by_step IS NOT NULL THEN
    SELECT NULLIF(w.inputs->>'feature_id','')::uuid INTO NEW.feature_id
    FROM public.step_runs sr
    JOIN public.workflow_runs w ON w.id = sr.run_id
    WHERE sr.id = NEW.created_by_step;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tasks_fill_feature ON public.tasks;
CREATE TRIGGER tasks_fill_feature BEFORE INSERT ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.tasks_fill_feature();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'schema_migrations') THEN
    INSERT INTO public.schema_migrations(filename) VALUES ('0032_sdf_18_feature_scope.sql') ON CONFLICT DO NOTHING;
  END IF;
END $$;
