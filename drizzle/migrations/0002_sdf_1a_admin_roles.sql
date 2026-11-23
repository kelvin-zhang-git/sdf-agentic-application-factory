GRANT INSERT, DELETE ON public.user_roles TO authenticated;
CREATE POLICY user_roles_admin_insert ON public.user_roles FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());
CREATE POLICY user_roles_admin_delete ON public.user_roles FOR DELETE TO authenticated
  USING (public.is_admin() AND NOT (user_id = auth.uid() AND role = 'admin'::public.global_role));