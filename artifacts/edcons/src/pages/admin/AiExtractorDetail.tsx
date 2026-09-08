import { useEffect, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { ArrowLeft, Plus, Trash2, Play, Save } from "lucide-react";
import { SUPPORTED_LANGUAGES } from "@/lib/i18n";

type FieldType = "string" | "number" | "date" | "boolean" | "enum";
interface Field {
  key: string;
  label: string;
  description?: string;
  type: FieldType;
  required?: boolean;
  enumValues?: string[];
  normalize?: "gpa100" | "dateYmd" | "none";
  format?: string;
  labelByLang?: Record<string, string>;
}

interface Extractor {
  id?: number;
  name: string;
  slug: string;
  description: string;
  provider: "anthropic" | "openai" | "gemini";
  model: string;
  systemPrompt: string;
  systemPromptByLang: Record<string, string>;
  fields: Field[];
  rules: { globalRules: string[]; perDocType: Record<string, string[]> };
  scopes: string[];
  documentTypes: string[];
  temperature: number;
  maxTokens: number;
  isActive: boolean;
  isDefault: boolean;
}

const SCOPES = ["public_apply", "embed", "staff", "agent"] as const;
const LANGS = SUPPORTED_LANGUAGES;
const FIELD_TYPES: FieldType[] = ["string", "number", "date", "boolean", "enum"];

const EMPTY: Extractor = {
  name: "",
  slug: "",
  description: "",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  systemPrompt: "",
  systemPromptByLang: {},
  fields: [
    { key: "firstName", label: "First name", type: "string", required: true, normalize: "none" },
  ],
  rules: { globalRules: [], perDocType: {} },
  scopes: ["public_apply", "staff"],
  documentTypes: ["passport"],
  temperature: 0.2,
  maxTokens: 4096,
  isActive: true,
  isDefault: false,
};

export default function AiExtractorDetail() {
  const { t } = useI18n();
  const [, setLocation] = useLocation();
  const [, params] = useRoute("/admin/ai-extractors/:id");
  const idParam = params?.id;
  const isNew = idParam === "new" || !idParam;
  const [data, setData] = useState<Extractor>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(!isNew);
  const [activeLang, setActiveLang] = useState<string>("en");
  const [testResult, setTestResult] = useState<any>(null);
  const [testing, setTesting] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (isNew) return;
    (async () => {
      try {
        const r = await customFetch<{ extractor: Extractor }>(`/api/ai-extractors/${idParam}`);
        setData({
          ...EMPTY,
          ...r.extractor,
          systemPromptByLang: r.extractor.systemPromptByLang || {},
          rules: r.extractor.rules || { globalRules: [], perDocType: {} },
          temperature: Number(r.extractor.temperature),
        });
      } catch (e) {
        toast({ title: t("aiExtractor.toastError"), description: (e as Error).message, variant: "destructive" });
      } finally {
        setLoading(false);
      }
    })();
  }, [idParam, isNew]);

  const save = async () => {
    setSaving(true);
    try {
      const payload = { ...data };
      if (isNew) {
        const r = await customFetch<{ extractor: { id: number } }>("/api/ai-extractors", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        toast({ title: t("aiExtractor.toastSaved") });
        setLocation(`/admin/ai-extractors/${r.extractor.id}`);
      } else {
        await customFetch(`/api/ai-extractors/${idParam}`, { method: "PUT", body: JSON.stringify(payload) });
        toast({ title: t("aiExtractor.toastSaved") });
      }
    } catch (e) {
      toast({ title: t("aiExtractor.toastError"), description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    if (isNew || !data.id) {
      toast({ title: t("aiExtractor.testSaveFirst"), variant: "destructive" });
      return;
    }
    const file = (document.getElementById("test-file") as HTMLInputElement)?.files?.[0];
    if (!file) {
      toast({ title: t("aiExtractor.testNoFile"), variant: "destructive" });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const b64: string = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1]);
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      const isPdf = file.type === "application/pdf";
      const r = await customFetch<any>(`/api/ai-extractors/${data.id}/test`, {
        method: "POST",
        body: JSON.stringify({
          documents: [{ type: isPdf ? "pdf" : "image", data: b64, mediaType: file.type, label: file.name }],
          lang: activeLang,
        }),
      });
      setTestResult(r);
    } catch (e) {
      toast({ title: t("aiExtractor.toastError"), description: (e as Error).message, variant: "destructive" });
    } finally {
      setTesting(false);
    }
  };

  const update = <K extends keyof Extractor>(k: K, v: Extractor[K]) => setData((d) => ({ ...d, [k]: v }));

  const addField = () => update("fields", [...data.fields, { key: "newField", label: "New field", type: "string", normalize: "none" }]);
  const removeField = (i: number) => update("fields", data.fields.filter((_, idx) => idx !== i));
  const setField = (i: number, patch: Partial<Field>) =>
    update("fields", data.fields.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));

  if (loading) return <div className="p-6 text-sm text-muted-foreground">{t("aiExtractor.loading")}</div>;

  return (
    <div className="p-6 space-y-4 max-w-5xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Button variant="ghost" onClick={() => setLocation("/admin/ai-extractors")}>
          <ArrowLeft className="h-4 w-4 mr-2" /> {t("aiExtractor.back")}
        </Button>
        <div className="flex items-center gap-2">
          <Badge variant={data.isActive ? "default" : "secondary"}>
            {data.isActive ? t("aiExtractor.active") : t("aiExtractor.inactive")}
          </Badge>
          {data.isDefault && <Badge variant="outline">{t("aiExtractor.defaultBadge")}</Badge>}
          <Button onClick={save} disabled={saving}>
            <Save className="h-4 w-4 mr-2" /> {saving ? t("aiExtractor.saving") : t("aiExtractor.save")}
          </Button>
        </div>
      </div>

      <h1 className="text-xl font-semibold">
        {isNew ? t("aiExtractor.newExtractor") : data.name || t("aiExtractor.extractorNum", { id: data.id ?? "" })}
      </h1>

      <Tabs defaultValue="general">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="general">{t("aiExtractor.tabGeneral")}</TabsTrigger>
          <TabsTrigger value="prompt">{t("aiExtractor.tabPrompt")}</TabsTrigger>
          <TabsTrigger value="model">{t("aiExtractor.tabModel")}</TabsTrigger>
          <TabsTrigger value="fields">{t("aiExtractor.tabFields")}</TabsTrigger>
          <TabsTrigger value="rules">{t("aiExtractor.tabRules")}</TabsTrigger>
          <TabsTrigger value="scope">{t("aiExtractor.tabScope")}</TabsTrigger>
          <TabsTrigger value="test">{t("aiExtractor.tabTest")}</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="space-y-3">
          <Card>
            <CardContent className="pt-4 space-y-3">
              <div>
                <Label>{t("aiExtractor.fName")}</Label>
                <Input value={data.name} onChange={(e) => update("name", e.target.value)} />
              </div>
              <div>
                <Label>{t("aiExtractor.fSlug")}</Label>
                <Input value={data.slug} onChange={(e) => update("slug", e.target.value)} placeholder="passport-diploma-extractor" />
              </div>
              <div>
                <Label>{t("aiExtractor.fDescription")}</Label>
                <Textarea value={data.description} onChange={(e) => update("description", e.target.value)} rows={3} />
              </div>
              <div className="flex items-center gap-3">
                <Switch checked={data.isActive} onCheckedChange={(v) => update("isActive", v)} />
                <Label>{t("aiExtractor.fActive")}</Label>
              </div>
              <div className="flex items-center gap-3">
                <Switch checked={data.isDefault} onCheckedChange={(v) => update("isDefault", v)} />
                <Label>{t("aiExtractor.fDefault")}</Label>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="prompt" className="space-y-3">
          <Card>
            <CardHeader><CardTitle className="text-sm">{t("aiExtractor.systemPrompt")}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">{t("aiExtractor.promptHint")}</p>
              <Textarea
                value={data.systemPrompt}
                onChange={(e) => update("systemPrompt", e.target.value)}
                rows={8}
                placeholder={t("aiExtractor.systemPromptPlaceholder")}
              />
              <div className="border-t pt-3 space-y-2">
                <Label>{t("aiExtractor.localizedPrompt")}</Label>
                <div className="flex flex-wrap gap-1">
                  {LANGS.map((l) => (
                    <Button
                      key={l}
                      size="sm"
                      variant={activeLang === l ? "default" : "outline"}
                      onClick={() => setActiveLang(l)}
                    >
                      {l.toUpperCase()}
                    </Button>
                  ))}
                </div>
                <Textarea
                  value={data.systemPromptByLang[activeLang] || ""}
                  onChange={(e) =>
                    update("systemPromptByLang", { ...data.systemPromptByLang, [activeLang]: e.target.value })
                  }
                  rows={6}
                  placeholder={t("aiExtractor.localizedPromptPlaceholder", { lang: activeLang })}
                />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="model" className="space-y-3">
          <Card>
            <CardContent className="pt-4 space-y-3">
              <div>
                <Label>{t("aiExtractor.provider")}</Label>
                <Select value={data.provider} onValueChange={(v) => update("provider", v as any)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="anthropic">{t("aiExtractor.providerAnthropic")}</SelectItem>
                    <SelectItem value="openai">{t("aiExtractor.providerOpenai")}</SelectItem>
                    <SelectItem value="gemini">{t("aiExtractor.providerGemini")}</SelectItem>
                  </SelectContent>
                </Select>
                {data.provider !== "anthropic" && (
                  <p className="text-xs text-amber-600 mt-1">{t("aiExtractor.providerNotWired")}</p>
                )}
              </div>
              <div>
                <Label>{t("aiExtractor.model")}</Label>
                <Input value={data.model} onChange={(e) => update("model", e.target.value)} />
                <p className="text-xs text-muted-foreground mt-1">{t("aiExtractor.modelHint")}</p>
              </div>
              <div>
                <Label>{t("aiExtractor.temperature", { value: data.temperature.toFixed(2) })}</Label>
                <Input
                  type="range" min={0} max={1} step={0.05}
                  value={data.temperature}
                  onChange={(e) => update("temperature", Number(e.target.value))}
                />
              </div>
              <div>
                <Label>{t("aiExtractor.maxTokens")}</Label>
                <Input
                  type="number" min={256} max={32000}
                  value={data.maxTokens}
                  onChange={(e) => update("maxTokens", Number(e.target.value))}
                />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="fields" className="space-y-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-sm">{t("aiExtractor.fieldsTitle")}</CardTitle>
              <Button size="sm" onClick={addField}><Plus className="h-3 w-3 mr-1" /> {t("aiExtractor.addField")}</Button>
            </CardHeader>
            <CardContent className="space-y-2">
              {data.fields.map((f, i) => (
                <div key={i} className="border rounded p-3 space-y-2">
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                    <div>
                      <Label className="text-xs">{t("aiExtractor.fieldKey")}</Label>
                      <Input value={f.key} onChange={(e) => setField(i, { key: e.target.value })} />
                    </div>
                    <div>
                      <Label className="text-xs">{t("aiExtractor.fieldLabel")}</Label>
                      <Input value={f.label} onChange={(e) => setField(i, { label: e.target.value })} />
                    </div>
                    <div>
                      <Label className="text-xs">{t("aiExtractor.fieldType")}</Label>
                      <Select value={f.type} onValueChange={(v) => setField(i, { type: v as FieldType })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {FIELD_TYPES.map((tp) => <SelectItem key={tp} value={tp}>{tp}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-xs">{t("aiExtractor.fieldNormalize")}</Label>
                      <Select value={f.normalize || "none"} onValueChange={(v) => setField(i, { normalize: v as any })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">{t("aiExtractor.normalizeNone")}</SelectItem>
                          <SelectItem value="gpa100">{t("aiExtractor.normalizeGpa100")}</SelectItem>
                          <SelectItem value="dateYmd">{t("aiExtractor.normalizeDateYmd")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs">{t("aiExtractor.fieldDescription")}</Label>
                    <Input value={f.description || ""} onChange={(e) => setField(i, { description: e.target.value })} />
                  </div>
                  {f.type === "enum" && (
                    <div>
                      <Label className="text-xs">{t("aiExtractor.fieldEnum")}</Label>
                      <Input
                        value={(f.enumValues || []).join(", ")}
                        onChange={(e) => setField(i, { enumValues: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                        placeholder="passport, diploma, transcript"
                      />
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <label className="flex items-center gap-2">
                      <Switch checked={!!f.required} onCheckedChange={(v) => setField(i, { required: v })} />
                      {t("aiExtractor.fieldRequired")}
                    </label>
                    <Button size="sm" variant="ghost" onClick={() => removeField(i)}>
                      <Trash2 className="h-3 w-3 text-rose-500" />
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="rules" className="space-y-3">
          <Card>
            <CardHeader><CardTitle className="text-sm">{t("aiExtractor.globalRules")}</CardTitle></CardHeader>
            <CardContent>
              <Textarea
                rows={10}
                value={(data.rules.globalRules || []).join("\n")}
                onChange={(e) =>
                  update("rules", { ...data.rules, globalRules: e.target.value.split("\n").map((l) => l.trim()).filter(Boolean) })
                }
                placeholder={t("aiExtractor.rulesPlaceholder")}
              />
              <p className="text-xs text-muted-foreground mt-2">{t("aiExtractor.rulesHint")}</p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="scope" className="space-y-3">
          <Card>
            <CardContent className="pt-4 space-y-3">
              <div>
                <Label>{t("aiExtractor.scopes")}</Label>
                <div className="flex flex-wrap gap-2 mt-1">
                  {SCOPES.map((s) => {
                    const on = data.scopes.includes(s);
                    return (
                      <Badge
                        key={s}
                        variant={on ? "default" : "outline"}
                        className="cursor-pointer"
                        onClick={() =>
                          update("scopes", on ? data.scopes.filter((x) => x !== s) : [...data.scopes, s])
                        }
                      >
                        {t(`aiExtractor.scope_${s}`)}
                      </Badge>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground mt-2">{t("aiExtractor.scopesHint")}</p>
              </div>
              <div>
                <Label>{t("aiExtractor.documentTypes")}</Label>
                <Input
                  value={data.documentTypes.join(", ")}
                  onChange={(e) => update("documentTypes", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
                  placeholder="passport, diploma, transcript"
                />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="test" className="space-y-3">
          <Card>
            <CardHeader><CardTitle className="text-sm">{t("aiExtractor.testTitle")}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">{t("aiExtractor.testHint")}</p>
              <input id="test-file" type="file" accept="image/*,application/pdf" className="text-sm" />
              <div className="flex items-center gap-2">
                <Label className="text-xs">{t("aiExtractor.testLang")}</Label>
                <Select value={activeLang} onValueChange={setActiveLang}>
                  <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {LANGS.map((l) => <SelectItem key={l} value={l}>{l.toUpperCase()}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Button size="sm" onClick={runTest} disabled={testing || isNew}>
                  <Play className="h-3 w-3 mr-1" /> {testing ? t("aiExtractor.testing") : t("aiExtractor.runTest")}
                </Button>
              </div>
              {testResult && (
                <div className="space-y-2">
                  <div className="text-xs text-muted-foreground">
                    {t("aiExtractor.testLatency", { ms: testResult.usage?.latencyMs ?? "?" })} ·{" "}
                    {t("aiExtractor.testTokens", { in: testResult.usage?.promptTokens ?? "?", out: testResult.usage?.completionTokens ?? "?" })}
                  </div>
                  <div>
                    <Label className="text-xs">{t("aiExtractor.testExtracted")}</Label>
                    <pre className="bg-muted p-2 rounded text-xs whitespace-pre-wrap max-h-96 overflow-auto">
                      {JSON.stringify(testResult.extracted, null, 2)}
                    </pre>
                  </div>
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground">{t("aiExtractor.testPrompt")}</summary>
                    <pre className="bg-muted p-2 rounded whitespace-pre-wrap max-h-64 overflow-auto mt-1">
                      {testResult.prompt}
                    </pre>
                  </details>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
