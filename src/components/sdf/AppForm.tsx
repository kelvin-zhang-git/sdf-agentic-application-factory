import { useState } from "react";
import type { AppInput } from "@/data/sdf";
import { CLASS_LABEL, PHASE_LABEL } from "@/data/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorBox } from "./common";

export function AppForm({ initial, submitLabel, onSubmit, disabled = false }: {
  initial?: Partial<AppInput>; submitLabel: string; onSubmit: (v: AppInput & { domain_pack?: "automotive" }) => Promise<void>; disabled?: boolean | undefined;
}) {
  const [v, setV] = useState<AppInput>({
    name: initial?.name ?? "", description: initial?.description ?? "", phase: initial?.phase ?? "development",
    classification: initial?.classification ?? "internal", redact_before_llm: initial?.redact_before_llm ?? false,
    redact_terms: initial?.redact_terms ?? [],
    current_version: initial?.current_version ?? null,
  });
  const [termsText, setTermsText] = useState((initial?.redact_terms ?? []).join("\n"));
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [pack, setPack] = useState(false);
  return (
    <form className="space-y-4" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr(null);
      const terms = Array.from(new Set(termsText.split(/[\r\n,，]+/).map((s) => s.trim()).filter((s) => s.length >= 2))).slice(0, 50);
      try { await onSubmit({ ...v, redact_terms: terms, ...(!initial && pack ? { domain_pack: "automotive" } : {}) }); } catch (x) { setErr(x); } finally { setBusy(false); }
    }}>
      <div className="space-y-2"><Label htmlFor="app-name">应用名称</Label>
        <Input id="app-name" required maxLength={100} disabled={disabled} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></div>
      <div className="space-y-2"><Label htmlFor="app-desc">简介</Label>
        <Textarea id="app-desc" maxLength={2000} disabled={disabled} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} /></div>
      <div className="grid grid-cols-3 gap-4">
        <div className="space-y-2"><Label>阶段</Label>
          <Select disabled={disabled} value={v.phase} onValueChange={(x) => setV({ ...v, phase: x as AppInput["phase"] })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{Object.entries(PHASE_LABEL).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
          </Select></div>
        <div className="space-y-2"><Label>数据密级</Label>
          <Select disabled={disabled} value={v.classification} onValueChange={(x) => setV({ ...v, classification: x as AppInput["classification"] })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{Object.entries(CLASS_LABEL).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
          </Select></div>
        <div className="space-y-2"><Label htmlFor="app-ver">当前版本</Label>
          <Input id="app-ver" maxLength={30} disabled={disabled} value={v.current_version ?? ""} placeholder="如 v1.0" onChange={(e) => setV({ ...v, current_version: e.target.value || null })} /></div>
      </div>
      {!initial && (
        <label className="flex items-center gap-3 text-sm">
          <input type="checkbox" checked={pack} disabled={disabled} onChange={(event) => setPack(event.target.checked)} />
          套用汽车领域包（数据字典、五个功能和模拟接口）
        </label>
      )}
      <label className="flex items-center gap-3 text-sm">
        <Switch disabled={disabled} checked={v.redact_before_llm} onCheckedChange={(c) => setV({ ...v, redact_before_llm: c })} />
        发送给模型前脱敏（手机号、身份证号、邮箱、银行卡号、VIN 码、内网 IP 及自定义词表）
      </label>
      {v.redact_before_llm && (
        <div className="space-y-1.5">
          <Label htmlFor="app-redact-terms">自定义脱敏词表（可选，每行或用逗号分隔，至少 2 个字符）</Label>
          <Textarea
            id="app-redact-terms"
            rows={3}
            disabled={disabled}
            placeholder="例如：车型代号、供应商全称、专有零件号前缀"
            value={termsText}
            onChange={(e) => setTermsText(e.target.value)}
          />
        </div>
      )}
      <ErrorBox error={err} />
      {!disabled && <Button type="submit" disabled={busy}>{busy ? "保存中…" : submitLabel}</Button>}
    </form>
  );
}
