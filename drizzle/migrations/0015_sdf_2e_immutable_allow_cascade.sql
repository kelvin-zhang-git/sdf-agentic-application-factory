CREATE OR REPLACE FUNCTION public.sdf_forbid_change() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_TABLE_NAME = 'workflows' THEN
    IF NOT (to_jsonb(OLD)->>'is_builtin')::boolean THEN RETURN COALESCE(NEW, OLD); END IF;
  ELSIF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    -- removal cascaded from deleting the owning app; direct edits/deletes stay forbidden
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'SDF_IMMUTABLE: % rows cannot be changed', TG_TABLE_NAME;
END $$;