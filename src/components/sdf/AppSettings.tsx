import { useQueryClient, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Trash2, UserPlus, Users as UsersIcon } from "lucide-react";
import { toast } from "sonner";
import { addContact, addMember, appDirectoryQuery, auditQuery, contactsQuery, linkContact, membersQuery, removeContact, setAppUserRoles } from "@/data/sdf";
import { downloadFile } from "@/data/download";
import { ROLE_LABEL, type AppRole } from "@/data/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorBox, errorText, Mono } from "./common";

const APP_ROLES: AppRole[] = ["lead", "ba", "architect", "security", "dev", "qa", "business"];

function RoleSelect({ value, onChange }: { value: AppRole; onChange: (r: AppRole) => void }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as AppRole)}>
      <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
      <SelectContent>{APP_ROLES.map((r) => <SelectItem key={r} value={r}>{ROLE_LABEL[r]}</SelectItem>)}</SelectContent>
    </Select>
  );
}

interface TeamRow {
  user_id: string;
  display_name: string;
  email: string | null;
  roles: AppRole[];
  expires_at: string | null;
}

export function MembersSection({ appId, canManage }: { appId: string; canManage: boolean }) {
  const q = useQuery(membersQuery(appId));
  const dir = useQuery({ ...appDirectoryQuery(appId), enabled: canManage });
  const qc = useQueryClient();

  const [pickedUserId, setPickedUserId] = useState("");
  const [search, setSearch] = useState("");
  const [manualEmail, setManualEmail] = useState("");
  const [pickedRoles, setPickedRoles] = useState<AppRole[]>(["ba"]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["app", appId] });
    void qc.invalidateQueries({ queryKey: ["admin", "users"] });
    void qc.invalidateQueries({ queryKey: ["audit"] });
  };

  // 按人聚合项目成员，支持一人在本项目身兼多角且互不影响其他项目
  const team = useMemo<TeamRow[]>(() => {
    const map = new Map<string, TeamRow>();
    for (const m of q.data ?? []) {
      const existing = map.get(m.user_id) ?? {
        user_id: m.user_id,
        display_name: m.profiles?.display_name || m.profiles?.email || m.user_id,
        email: m.profiles?.email ?? null,
        roles: [],
        expires_at: m.expires_at ?? null,
      };
      if (!existing.roles.includes(m.role)) existing.roles.push(m.role);
      if (!existing.expires_at && m.expires_at) existing.expires_at = m.expires_at;
      map.set(m.user_id, existing);
    }
    return Array.from(map.values());
  }, [q.data]);

  const memberIds = useMemo(() => new Set(team.map((t) => t.user_id)), [team]);
  const candidates = useMemo(() => {
    const kw = search.trim().toLowerCase();
    return (dir.data ?? [])
      .filter((u) => !memberIds.has(u.id))
      .filter((u) => !kw || u.display_name.toLowerCase().includes(kw) || (u.email ?? "").toLowerCase().includes(kw));
  }, [dir.data, memberIds, search]);

  const roleCounts = useMemo(() => {
    const counts = Object.fromEntries(APP_ROLES.map((r) => [r, 0])) as Record<AppRole, number>;
    for (const member of team) {
      for (const r of member.roles) counts[r] = (counts[r] ?? 0) + 1;
    }
    return counts;
  }, [team]);

  const togglePickedRole = (r: AppRole) => {
    setPickedRoles((prev) => (prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]));
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 font-semibold">
            <UsersIcon className="h-4 w-4 text-primary" />
            <span>项目虚拟团队（Virtual Team）</span>
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            按当前项目独立分配成员角色与审批权。同一位成员可以在不同项目中承担不同角色，也可以在本项目中身兼多个角色。
          </p>
        </div>
        <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">共 {team.length} 位成员</span>
      </div>

      {/* 7 角色覆盖人数速览 */}
      <div className="flex flex-wrap gap-2">
        {APP_ROLES.map((r) => (
          <Badge key={r} variant={roleCounts[r] > 0 ? "secondary" : "outline"} className="gap-1 font-normal">
            <span>{ROLE_LABEL[r]}</span>
            <span className="font-mono text-xs font-semibold tabular-nums">{roleCounts[r]}</span>
          </Badge>
        ))}
      </div>

      {/* 拉人进入本项目虚拟团队 */}
      {canManage && (
        <form
          className="space-y-3 rounded-md border border-border bg-muted/20 p-3.5"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            if (!pickedRoles.length) {
              toast.error("请至少为该成员勾选一个项目角色");
              return;
            }
            setBusy(true);
            try {
              if (pickedUserId) {
                await setAppUserRoles(appId, pickedUserId, pickedRoles);
                setPickedUserId("");
                setSearch("");
                toast.success("已拉入项目虚拟团队");
              } else if (manualEmail.trim()) {
                for (const r of pickedRoles) {
                  await addMember(appId, manualEmail.trim(), r);
                }
                setManualEmail("");
                toast.success("已按邮箱拉入项目虚拟团队");
              } else {
                toast.error("请先从用户目录选择成员，或填写已注册用户邮箱");
                return;
              }
              refresh();
            } catch (x) {
              setErr(x);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="筛选平台用户（姓名或邮箱）"
              className="w-52 bg-background"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select value={pickedUserId} onValueChange={(v) => { setPickedUserId(v); setManualEmail(""); }}>
              <SelectTrigger className="w-72 bg-background" aria-label="选择要拉入项目的已注册用户">
                <SelectValue placeholder={candidates.length ? `从目录选择用户（剩余 ${candidates.length} 人）` : "全部已注册用户已在团队中"} />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.display_name || u.email}（{u.email ?? u.id.slice(0, 8)}）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground">或</span>
            <Input
              type="email"
              placeholder="直接输入已注册邮箱"
              className="w-56 bg-background"
              value={manualEmail}
              onChange={(e) => { setManualEmail(e.target.value); if (e.target.value) setPickedUserId(""); }}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span className="font-medium text-muted-foreground">分配本项目角色：</span>
              {APP_ROLES.map((r) => (
                <label key={r} className="flex cursor-pointer items-center gap-1.5">
                  <Checkbox checked={pickedRoles.includes(r)} onCheckedChange={() => togglePickedRole(r)} />
                  <span>{ROLE_LABEL[r]}</span>
                </label>
              ))}
            </div>
            <Button type="submit" size="sm" disabled={busy}>
              <UserPlus className="h-3.5 w-3.5" />
              <span>拉入团队</span>
            </Button>
          </div>
        </form>
      )}

      <ErrorBox error={err ?? q.error} />

      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead>成员</TableHead>
              {APP_ROLES.map((r) => (
                <TableHead key={r} className="text-center text-xs">{ROLE_LABEL[r]}</TableHead>
              ))}
              <TableHead>本项目有效期</TableHead>
              {canManage && <TableHead className="text-right">操作</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {team.map((member) => (
              <TableRow key={member.user_id}>
                <TableCell>
                  <div className="font-medium text-foreground">{member.display_name}</div>
                  {member.email && <Mono>{member.email}</Mono>}
                </TableCell>
                {APP_ROLES.map((r) => {
                  const checked = member.roles.includes(r);
                  return (
                    <TableCell key={r} className="text-center">
                      {canManage ? (
                        <Checkbox
                          aria-label={`${member.display_name} ${ROLE_LABEL[r]}`}
                          checked={checked}
                          onCheckedChange={async (c) => {
                            const next = c === true ? [...member.roles, r] : member.roles.filter((x) => x !== r);
                            if (next.length === 0) {
                              toast.error("至少保留一个角色；如需移出团队请点右侧移除按钮");
                              return;
                            }
                            try {
                              await setAppUserRoles(appId, member.user_id, next);
                              refresh();
                            } catch (x) {
                              toast.error(errorText(x));
                            }
                          }}
                        />
                      ) : (
                        checked ? <Badge variant="outline" className="text-[11px]">✓</Badge> : <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  );
                })}
                <TableCell>
                  {canManage ? (
                    <input
                      className="h-8 rounded border px-2 text-xs"
                      type="date"
                      aria-label={`${member.display_name}有效期`}
                      value={member.expires_at ? member.expires_at.slice(0, 10) : ""}
                      onChange={async (event) => {
                        const value = event.target.value;
                        try {
                          await setAppUserRoles(appId, member.user_id, member.roles, value ? new Date(`${value}T23:59:59`).toISOString() : null);
                          refresh();
                          toast.success(value ? "已设置成员有效期" : "已取消成员有效期");
                        } catch (x) {
                          toast.error(errorText(x));
                        }
                      }}
                    />
                  ) : (
                    <span className="text-xs">{member.expires_at ? new Date(member.expires_at).toLocaleDateString("zh-CN") : "长期"}</span>
                  )}
                </TableCell>
                {canManage && (
                  <TableCell className="text-right">
                    <Button
                      size="icon"
                      variant="ghost"
                      title="移出本项目虚拟团队"
                      aria-label={`移出 ${member.display_name}`}
                      onClick={async () => {
                        try {
                          await setAppUserRoles(appId, member.user_id, []);
                          refresh();
                          toast.success(`已将 ${member.display_name} 移出本项目`);
                        } catch (x) {
                          toast.error(errorText(x));
                        }
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
            {!team.length && (
              <TableRow>
                <TableCell colSpan={APP_ROLES.length + (canManage ? 3 : 2)} className="py-6 text-center text-sm text-muted-foreground">
                  当前项目还没有配置虚拟团队成员。
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

export function ContactsSection({ appId, canManage, myUserId }: { appId: string; canManage: boolean; myUserId: string }) {
  const q = useQuery(contactsQuery(appId));
  const qc = useQueryClient();
  const [f, setF] = useState({ name: "", title: "", org: "", email: "", app_role: "business" as AppRole, is_business: true });
  const [err, setErr] = useState<unknown>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["app", appId, "contacts"] }); qc.invalidateQueries({ queryKey: ["audit"] }); };
  return (
    <section className="space-y-3">
      <div>
        <h3 className="font-semibold">业务联系人</h3>
        <p className="text-sm text-muted-foreground">没有登录账号的相关人员（如门店店长）。已注册的本人可以把联系人关联到自己的账号。</p>
      </div>
      {canManage && (
        <form className="flex flex-wrap items-center gap-2" onSubmit={async (e) => {
          e.preventDefault(); setErr(null);
          try {
            await addContact(appId, { ...f, email: f.email || null });
            setF({ ...f, name: "", title: "", org: "", email: "" }); refresh();
          } catch (x) { setErr(x); }
        }}>
          <Input required placeholder="姓名" className="w-28" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <Input placeholder="职务" className="w-32" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          <Input placeholder="部门/组织" className="w-32" value={f.org} onChange={(e) => setF({ ...f, org: e.target.value })} />
          <Input type="email" placeholder="邮箱（可选）" className="w-44" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          <RoleSelect value={f.app_role} onChange={(r) => setF({ ...f, app_role: r })} />
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={f.is_business} onCheckedChange={(c) => setF({ ...f, is_business: c === true })} />业务方</label>
          <Button type="submit">添加</Button>
        </form>
      )}
      <ErrorBox error={err ?? q.error} />
      <Table>
        <TableHeader><TableRow><TableHead>姓名</TableHead><TableHead>职务</TableHead><TableHead>应用中的角色</TableHead><TableHead>账号</TableHead><TableHead /></TableRow></TableHeader>
        <TableBody>
          {(q.data ?? []).map((ac) => {
            const c = ac.contacts; if (!c) return null;
            const mine = c.linked_profile_id === myUserId;
            return (
              <TableRow key={ac.id}>
                <TableCell>{c.name} {c.is_demo && <Badge variant="secondary" className="ml-1">示例数据</Badge>}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{[c.title, c.org].filter(Boolean).join(" · ")}</TableCell>
                <TableCell><Badge variant="outline">{ROLE_LABEL[ac.app_role]}</Badge>{ac.is_business && <Badge variant="secondary" className="ml-1">业务方</Badge>}</TableCell>
                <TableCell className="text-sm">
                  {c.linked_profile_id ? (mine ? "已关联到我" : "已关联账号") : "未关联"}
                </TableCell>
                <TableCell className="space-x-1 text-right">
                  {(!c.linked_profile_id || mine) && (
                    <Button size="sm" variant="outline" onClick={async () => {
                      try { await linkContact(appId, ac.id, mine); refresh(); } catch (x) { toast.error(errorText(x)); }
                    }}>{mine ? "取消关联" : "这是我"}</Button>
                  )}
                  {canManage && <Button size="icon" variant="ghost" aria-label="移除联系人" onClick={async () => {
                    try { await removeContact(appId, ac.id); refresh(); } catch (x) { toast.error(errorText(x)); }
                  }}><Trash2 className="h-4 w-4" /></Button>}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}

export function AuditSection({ appId }: { appId?: string }) {
  const [action, setAction] = useState("");
  const [targetType, setTargetType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const q = useQuery(auditQuery({
    ...(appId ? { appId } : {}),
    ...(action.trim() ? { action: action.trim() } : {}),
    ...(targetType.trim() ? { targetType: targetType.trim() } : {}),
    ...(from ? { from: new Date(from).toISOString() } : {}),
    ...(to ? { to: new Date(to).toISOString() } : {}),
  }));
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">操作记录</h3>
        <Button size="sm" variant="outline" onClick={() => downloadFile(`/audit?app_id=${appId}&format=csv${from ? `&from=${encodeURIComponent(new Date(from).toISOString())}` : ""}${to ? `&to=${encodeURIComponent(new Date(to).toISOString())}` : ""}`, "audit.csv", "text/csv").catch((e) => toast.error(errorText(e)))}>导出当前筛选</Button>
      </div>
      <div className="flex flex-wrap gap-2 text-sm">
        <input className="h-9 rounded border px-2" placeholder="操作，如 app." value={action} onChange={(event) => setAction(event.target.value)} />
        <input className="h-9 rounded border px-2" placeholder="对象类型" value={targetType} onChange={(event) => setTargetType(event.target.value)} />
        <input className="h-9 rounded border px-2" type="datetime-local" aria-label="开始时间" value={from} onChange={(event) => setFrom(event.target.value)} />
        <input className="h-9 rounded border px-2" type="datetime-local" aria-label="结束时间" value={to} onChange={(event) => setTo(event.target.value)} />
      </div>
      <ErrorBox error={q.error} />
      <Table>
        <TableHeader><TableRow><TableHead>时间</TableHead><TableHead>操作</TableHead><TableHead>对象</TableHead><TableHead>请求编号</TableHead></TableRow></TableHeader>
        <TableBody>
          {(q.data ?? []).map((a) => (
            <TableRow key={a.id}>
              <TableCell className="whitespace-nowrap text-sm">{new Date(a.created_at).toLocaleString("zh-CN")}</TableCell>
              <TableCell><Mono>{a.action}</Mono></TableCell>
              <TableCell><Mono>{a.target_type}</Mono></TableCell>
              <TableCell><Mono>{a.trace_id}</Mono></TableCell>
            </TableRow>
          ))}
          {q.data?.length === 0 && <TableRow><TableCell colSpan={4} className="text-center text-sm text-muted-foreground">暂无记录</TableCell></TableRow>}
        </TableBody>
      </Table>
    </section>
  );
}
