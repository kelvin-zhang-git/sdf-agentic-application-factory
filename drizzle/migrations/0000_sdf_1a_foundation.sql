REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM anon, authenticated;

CREATE TYPE public.global_role AS ENUM ('admin','lead','ba','architect','security','dev','qa','business');
CREATE TYPE public.app_role AS ENUM ('lead','ba','architect','security','dev','qa','business');

-- profiles
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text,
  display_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- global roles
CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.global_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- system state (singleton)
CREATE TABLE public.system_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton = true),
  bootstrapped_at timestamptz NOT NULL DEFAULT now(),
  bootstrapped_by uuid NOT NULL
);
GRANT ALL ON public.system_state TO service_role;
ALTER TABLE public.system_state ENABLE ROW LEVEL SECURITY;

-- apps
CREATE TABLE public.apps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  description text NOT NULL DEFAULT '',
  phase text NOT NULL DEFAULT 'development' CHECK (phase IN ('development','maintenance')),
  classification text NOT NULL DEFAULT 'internal' CHECK (classification IN ('public','internal','sensitive','confidential')),
  redact_before_llm boolean NOT NULL DEFAULT false,
  current_version text,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.apps TO authenticated;
GRANT ALL ON public.apps TO service_role;
ALTER TABLE public.apps ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.app_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, user_id, role)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_members TO authenticated;
GRANT ALL ON public.app_members TO service_role;
ALTER TABLE public.app_members ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  title text NOT NULL DEFAULT '',
  org text NOT NULL DEFAULT '',
  email text,
  is_demo boolean NOT NULL DEFAULT false,
  linked_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contacts TO authenticated;
GRANT ALL ON public.contacts TO service_role;
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.app_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  app_role public.app_role NOT NULL,
  is_business boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, contact_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_contacts TO authenticated;
GRANT ALL ON public.app_contacts TO service_role;
ALTER TABLE public.app_contacts ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trace_id text,
  actor_id uuid,
  app_id uuid,
  action text NOT NULL,
  target_type text,
  target_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_app_idx ON public.audit_logs(app_id, created_at DESC);
GRANT SELECT ON public.audit_logs TO authenticated;
GRANT ALL ON public.audit_logs TO service_role;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- permission functions
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin'::public.global_role)
$$;

CREATE OR REPLACE FUNCTION public.has_global_role(_roles text[])
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role::text = ANY(_roles))
$$;

-- _roles NULL = any role in the app
CREATE OR REPLACE FUNCTION public.has_app_role(_app_id uuid, _roles text[])
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.app_members
    WHERE app_id = _app_id AND user_id = auth.uid()
      AND (_roles IS NULL OR role::text = ANY(_roles))
  )
$$;

CREATE OR REPLACE FUNCTION public.shares_app_with(_other uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.app_members a JOIN public.app_members b ON a.app_id = b.app_id
    WHERE a.user_id = auth.uid() AND b.user_id = _other
  )
$$;

CREATE OR REPLACE FUNCTION public.can_see_contact(_contact_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.app_contacts ac JOIN public.app_members m ON m.app_id = ac.app_id
    WHERE ac.contact_id = _contact_id AND m.user_id = auth.uid()
  )
$$;

CREATE OR REPLACE FUNCTION public.can_manage_contact(_contact_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.app_contacts ac JOIN public.app_members m ON m.app_id = ac.app_id
    WHERE ac.contact_id = _contact_id AND m.user_id = auth.uid() AND m.role = 'lead'::public.app_role
  )
$$;

REVOKE EXECUTE ON FUNCTION public.is_admin(), public.has_global_role(text[]), public.has_app_role(uuid, text[]),
  public.shares_app_with(uuid), public.can_see_contact(uuid), public.can_manage_contact(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin(), public.has_global_role(text[]), public.has_app_role(uuid, text[]),
  public.shares_app_with(uuid), public.can_see_contact(uuid), public.can_manage_contact(uuid) TO authenticated, service_role;

-- bootstrap (atomic, service_role only)
CREATE OR REPLACE FUNCTION public.bootstrap_admin(_user_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE inserted boolean := false;
BEGIN
  INSERT INTO public.system_state(singleton, bootstrapped_by) VALUES (true, _user_id)
  ON CONFLICT (singleton) DO NOTHING
  RETURNING true INTO inserted;
  IF inserted IS TRUE THEN
    INSERT INTO public.user_roles(user_id, role) VALUES (_user_id, 'admin'::public.global_role)
    ON CONFLICT DO NOTHING;
    INSERT INTO public.user_roles(user_id, role) VALUES (_user_id, 'lead'::public.global_role)
    ON CONFLICT DO NOTHING;
    RETURN true;
  END IF;
  RETURN false;
END $$;
REVOKE EXECUTE ON FUNCTION public.bootstrap_admin(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bootstrap_admin(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.is_bootstrapped()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.system_state)
$$;
REVOKE EXECUTE ON FUNCTION public.is_bootstrapped() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_bootstrapped() TO authenticated, service_role;

-- profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.profiles(id, email, display_name)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email,'@',1)))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- creator becomes app lead
CREATE OR REPLACE FUNCTION public.handle_new_app()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.app_members(app_id, user_id, role) VALUES (NEW.id, NEW.created_by, 'lead'::public.app_role)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.handle_new_app() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER on_app_created AFTER INSERT ON public.apps
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_app();

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
CREATE TRIGGER apps_touch BEFORE UPDATE ON public.apps FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER profiles_touch BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER contacts_touch BEFORE UPDATE ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- policies
CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.is_admin() OR public.shares_app_with(id));
CREATE POLICY profiles_update_own ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid()) WITH CHECK (id = auth.uid());

CREATE POLICY user_roles_select ON public.user_roles FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_admin());

CREATE POLICY apps_select ON public.apps FOR SELECT TO authenticated
  USING (public.has_app_role(id, NULL) OR public.is_admin());
CREATE POLICY apps_insert ON public.apps FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND public.has_global_role(ARRAY['admin','lead']));
CREATE POLICY apps_update ON public.apps FOR UPDATE TO authenticated
  USING (public.has_app_role(id, ARRAY['lead']) OR public.is_admin())
  WITH CHECK (public.has_app_role(id, ARRAY['lead']) OR public.is_admin());
CREATE POLICY apps_delete ON public.apps FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY app_members_select ON public.app_members FOR SELECT TO authenticated
  USING (public.has_app_role(app_id, NULL) OR public.is_admin());
CREATE POLICY app_members_insert ON public.app_members FOR INSERT TO authenticated
  WITH CHECK (public.has_app_role(app_id, ARRAY['lead']) OR public.is_admin());
CREATE POLICY app_members_update ON public.app_members FOR UPDATE TO authenticated
  USING (public.has_app_role(app_id, ARRAY['lead']) OR public.is_admin())
  WITH CHECK (public.has_app_role(app_id, ARRAY['lead']) OR public.is_admin());
CREATE POLICY app_members_delete ON public.app_members FOR DELETE TO authenticated
  USING (public.has_app_role(app_id, ARRAY['lead']) OR public.is_admin());

CREATE POLICY contacts_select ON public.contacts FOR SELECT TO authenticated
  USING (public.is_admin() OR public.can_see_contact(id) OR created_by = auth.uid());
CREATE POLICY contacts_insert ON public.contacts FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND public.has_global_role(ARRAY['admin','lead','ba']));
CREATE POLICY contacts_update ON public.contacts FOR UPDATE TO authenticated
  USING (public.is_admin() OR public.can_manage_contact(id) OR created_by = auth.uid()
         OR (public.can_see_contact(id) AND linked_profile_id IS NULL))
  WITH CHECK (public.is_admin() OR public.can_manage_contact(id) OR created_by = auth.uid()
         OR (public.can_see_contact(id) AND (linked_profile_id IS NULL OR linked_profile_id = auth.uid())));
CREATE POLICY contacts_delete ON public.contacts FOR DELETE TO authenticated
  USING (public.is_admin() OR public.can_manage_contact(id));

CREATE POLICY app_contacts_select ON public.app_contacts FOR SELECT TO authenticated
  USING (public.has_app_role(app_id, NULL) OR public.is_admin());
CREATE POLICY app_contacts_insert ON public.app_contacts FOR INSERT TO authenticated
  WITH CHECK (public.has_app_role(app_id, ARRAY['lead','ba']) OR public.is_admin());
CREATE POLICY app_contacts_update ON public.app_contacts FOR UPDATE TO authenticated
  USING (public.has_app_role(app_id, ARRAY['lead','ba']) OR public.is_admin())
  WITH CHECK (public.has_app_role(app_id, ARRAY['lead','ba']) OR public.is_admin());
CREATE POLICY app_contacts_delete ON public.app_contacts FOR DELETE TO authenticated
  USING (public.has_app_role(app_id, ARRAY['lead']) OR public.is_admin());

CREATE POLICY audit_select ON public.audit_logs FOR SELECT TO authenticated
  USING (public.is_admin() OR actor_id = auth.uid()
         OR (app_id IS NOT NULL AND public.has_app_role(app_id, ARRAY['lead'])));