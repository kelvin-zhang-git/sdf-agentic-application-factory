# 1A permission and audit acceptance — 2026-11-13

## Scope and result
Passed the requested two-account application/contact isolation and application/member audit checks against the running app and real hosted data. No application code or policies were changed.

## Accounts and fixtures
- Existing global admin/lead created two clearly labelled acceptance applications: `1A验收-A-隔离` and `1A验收-B-授权`, each with one acceptance contact.
- The second registered account had no global roles and was temporarily added only to B with the `dev` role, through the member management UI.
- Membership was removed through the UI after testing. The second account's original no-membership state was restored; acceptance apps, contacts and audit records remain as evidence.

## Verified
- The second account's application list contained B only. Opening A returned 404; A's member/contact list returned no rows.
- B's contact was visible through the settings UI; A's contact was not. Direct caller-token database reads independently confirmed contact RLS filtering.
- Editing either application's basic information, creating/removing contacts, adding members and linking A's hidden contact were denied. Management controls were absent for the second account.
- After member removal, B returned 404 and its contact list returned no rows.
- Application creation and updates plus member additions/removals appeared in the administrator's audit view and persisted in the database.
- Required audit events have the correct actor, application, target and non-empty request trace. Member addition/removal target IDs and user IDs match.
- Existing routing and redaction tests: 6/6 passed.

## Audit event names
`app.created`, `app.updated`, `app.member_added`, `app.member_removed`; contact setup also produced `app.contact_added`.

## Boundaries
This confirms only the requested isolation/audit scope, not all 1A acceptance items. Initial-bootstrap concurrency and business-only portal behavior were not exercised in this run. No initialized production state was reset for testing.

## Individual live checks
- PASS: admin_create_app_and_contact_A
- PASS: admin_create_app_and_contact_B
- PASS: second_UI_only_authorized_app
- PASS: second_API_only_authorized_app
- PASS: second_hidden_app_detail
- PASS: second_hidden_app_contacts
- PASS: second_hidden_app_members
- PASS: second_UI_authorized_contact
- PASS: second_UI_no_management_controls
- PASS: second_denied_app_update_1A验收-A-隔离
- PASS: second_denied_contact_create_1A验收-A-隔离
- PASS: second_denied_contact_remove_1A验收-A-隔离
- PASS: second_denied_app_update_1A验收-B-授权
- PASS: second_denied_contact_create_1A验收-B-授权
- PASS: second_denied_contact_remove_1A验收-B-授权
- PASS: second_denied_hidden_contact_link
- PASS: second_denied_member_add
- PASS: direct_RLS_contact_1A验收-A-隔离
- PASS: direct_RLS_contact_1A验收-B-授权
- PASS: audit_required_actions
- PASS: audit_actor_target_trace
- PASS: audit_member_target_matches
- PASS: revocation_hides_contacts
- PASS: revocation_hides_app
