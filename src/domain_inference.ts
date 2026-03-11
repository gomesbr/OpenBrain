export type TaxonomyDomain =
  | "identity_profile"
  | "values_beliefs"
  | "personality_traits"
  | "emotional_baseline"
  | "mental_health_signals"
  | "cognitive_style"
  | "decision_behavior"
  | "attention_productivity"
  | "habit_systems"
  | "sleep_recovery"
  | "nutrition_eating_behavior"
  | "exercise_sports"
  | "medical_context"
  | "substance_use"
  | "energy_management"
  | "romantic_relationship"
  | "family_relationships"
  | "friendships"
  | "social_graph_dynamics"
  | "communication_style"
  | "memorable_moments"
  | "career_trajectory"
  | "work_performance"
  | "learning_growth"
  | "financial_behavior"
  | "lifestyle_environment"
  | "leisure_creativity"
  | "travel_mobility"
  | "life_goals_planning"
  | "personal_narrative"
  | "digital_behavior"
  | "reputation_network_capital"
  | "ethics_privacy_boundaries"
  | "risk_safety"
  | "meaning_spirituality"
  | "meta_memory_quality";

export const TAXONOMY_DOMAINS: TaxonomyDomain[] = [
  "identity_profile",
  "values_beliefs",
  "personality_traits",
  "emotional_baseline",
  "mental_health_signals",
  "cognitive_style",
  "decision_behavior",
  "attention_productivity",
  "habit_systems",
  "sleep_recovery",
  "nutrition_eating_behavior",
  "exercise_sports",
  "medical_context",
  "substance_use",
  "energy_management",
  "romantic_relationship",
  "family_relationships",
  "friendships",
  "social_graph_dynamics",
  "communication_style",
  "memorable_moments",
  "career_trajectory",
  "work_performance",
  "learning_growth",
  "financial_behavior",
  "lifestyle_environment",
  "leisure_creativity",
  "travel_mobility",
  "life_goals_planning",
  "personal_narrative",
  "digital_behavior",
  "reputation_network_capital",
  "ethics_privacy_boundaries",
  "risk_safety",
  "meaning_spirituality",
  "meta_memory_quality"
];

interface DomainOntologyEntry {
  domain: TaxonomyDomain;
  patterns: RegExp[];
  contextBoost: number;
}

export interface RelationshipHint {
  relationType: "spouse_partner" | "family" | "friend" | "colleague" | "community";
  confidence: number;
  reason: string;
  targetHint?: string;
}

export interface StructuredSignals {
  language: "en" | "pt" | "es" | "mixed" | "unknown";
  domainScores: Record<TaxonomyDomain, number>;
  domainTop: TaxonomyDomain[];
  domainEvidence: Record<TaxonomyDomain, string[]>;
  traitScores: Record<string, number>;
  relationshipHints: RelationshipHint[];
  confidence: number;
  isSystemEvent: boolean;
  noiseReasons: string[];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalize(input: string): string {
  return String(input ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function emptyDomainScores(): Record<TaxonomyDomain, number> {
  const out = {} as Record<TaxonomyDomain, number>;
  for (const domain of TAXONOMY_DOMAINS) {
    out[domain] = 0;
  }
  return out;
}

function detectLanguage(text: string): StructuredSignals["language"] {
  const t = normalize(text);
  if (!t) return "unknown";

  const en = (t.match(/\b(the|and|with|from|have|this|that|friend|wife|work|money)\b/g) ?? []).length;
  const pt = (t.match(/\b(que|com|para|voce|voce|nao|estou|amor|esposa|trabalho|dinheiro)\b/g) ?? []).length;
  const es = (t.match(/\b(que|con|para|estoy|amor|esposa|trabajo|dinero|amigo|familia)\b/g) ?? []).length;

  const top = Math.max(en, pt, es);
  if (top === 0) return "unknown";
  const winners = [en === top ? "en" : null, pt === top ? "pt" : null, es === top ? "es" : null].filter(Boolean);
  if (winners.length > 1) return "mixed";
  return winners[0] as StructuredSignals["language"];
}

const ONTOLOGY: DomainOntologyEntry[] = [
  { domain: "identity_profile", contextBoost: 0.45, patterns: [/\b(my name|i am|i'm|eu sou|meu nome|yo soy|mi nombre|born|birthday|idade|age|anos)\b/i] },
  { domain: "values_beliefs", contextBoost: 0.4, patterns: [/\b(value|values|belief|principle|ethic|faith|religio|politic|moral|creio|acredito|creencia|principio)\b/i] },
  { domain: "personality_traits", contextBoost: 0.45, patterns: [/\b(introvert|extrovert|personality|disciplin|organized|impulsiv|calm|patient|perfectionist|conscient|agreeable|openness|neurotic)\b/i] },
  { domain: "emotional_baseline", contextBoost: 0.55, patterns: [/\b(feel|feeling|mood|happy|sad|angry|frustrat|stress|feliz|triste|ansioso|ansiosa|alegre|enojado)\b/i] },
  { domain: "mental_health_signals", contextBoost: 0.55, patterns: [/\b(anxiety|anxious|depress|panic|burnout|therapy|therapist|mental health|ansiedade|depressao|depresion|psicolog|terapia)\b/i] },
  { domain: "cognitive_style", contextBoost: 0.35, patterns: [/\b(analy|intuition|bias|reasoning|problem solving|mental model|hipotese|hipotesis)\b/i] },
  { domain: "decision_behavior", contextBoost: 0.35, patterns: [/\b(decide|decision|risk|procrast|follow through|impuls|hesitant|deliberate)\b/i] },
  { domain: "attention_productivity", contextBoost: 0.35, patterns: [/\b(focus|deep work|pomodoro|distract|productiv|multitask|concentr)\b/i] },
  { domain: "habit_systems", contextBoost: 0.35, patterns: [/\b(habit|routine|streak|discipline|consisten|tracking|ritual|ritmo)\b/i] },
  { domain: "sleep_recovery", contextBoost: 0.45, patterns: [/\b(sleep|insomnia|bedtime|fatigue|tired|rest|recovery|dormi|dormir|sueno)\b/i] },
  { domain: "nutrition_eating_behavior", contextBoost: 0.45, patterns: [/\b(food|eat|meal|diet|calorie|protein|nutrition|comida|dieta|desayuno|almoco|jantar)\b/i] },
  { domain: "exercise_sports", contextBoost: 0.45, patterns: [/\b(workout|gym|run|soccer|football|pickleball|tennis|crossfit|exercise|treino|esporte|deporte)\b/i] },
  { domain: "medical_context", contextBoost: 0.55, patterns: [/\b(doctor|hospital|clinic|medicine|medic|symptom|diagnos|injury|medico|clinica|sintoma|operac)\b/i] },
  { domain: "substance_use", contextBoost: 0.45, patterns: [/\b(caffeine|coffee|alcohol|beer|wine|nicotine|smoke|drug|cafe|cerveja|vinho|tabaco)\b/i] },
  { domain: "energy_management", contextBoost: 0.4, patterns: [/\b(energy|drained|exhausted|crash|peak|energi|cansado|agotado)\b/i] },
  { domain: "romantic_relationship", contextBoost: 0.7, patterns: [/\b(wife|husband|spouse|marriage|married|girlfriend|boyfriend|partner|esposa|marido|novia|novio|namorada|namorado|te amo|my love|mi amor|amor)\b/i] },
  { domain: "family_relationships", contextBoost: 0.7, patterns: [/\b(mom|dad|mother|father|brother|sister|family|cousin|uncle|aunt|mae|pai|irmao|irma|familia|tio|tia)\b/i] },
  { domain: "friendships", contextBoost: 0.65, patterns: [/\b(friend|buddy|bro|pal|amigo|amiga|mano|maninha|colega)\b/i] },
  { domain: "social_graph_dynamics", contextBoost: 0.45, patterns: [/\b(group|community|network|influence|introduce|connect|grupo|comunidad|rede)\b/i] },
  { domain: "communication_style", contextBoost: 0.4, patterns: [/\b(tone|communicat|assertive|empat|argue|joke|humor|tom|empatia|discusion)\b/i] },
  { domain: "memorable_moments", contextBoost: 0.5, patterns: [/\b(remember|memorable|laughed|funny|joke|win|loss|recordar|recuerdo|lembro|vitoria|derrota)\b/i] },
  { domain: "career_trajectory", contextBoost: 0.45, patterns: [/\b(career|promotion|role change|resume|linkedin|cargo|promocao|carreira|empleo)\b/i] },
  { domain: "work_performance", contextBoost: 0.55, patterns: [/\b(project|client|deadline|meeting|repo|pull request|deployment|ticket|sprint|projeto|cliente|reuniao|trabajo)\b/i] },
  { domain: "learning_growth", contextBoost: 0.45, patterns: [/\b(learn|course|study|practice|skill|improv|book|aprend|curso|estudio|habilidad)\b/i] },
  { domain: "financial_behavior", contextBoost: 0.6, patterns: [/\b(money|budget|saving|invest|portfolio|bank|account|tax|salary|income|expense|dinheiro|dinero|conta|saldo|renda|despesa|401k|roth|robinhood)\b/i] },
  { domain: "lifestyle_environment", contextBoost: 0.45, patterns: [/\b(home|house|apartment|commute|neighborhood|weather|routine|casa|hogar|bairro|clima)\b/i] },
  { domain: "leisure_creativity", contextBoost: 0.45, patterns: [/\b(hobby|music|movie|game|creative|paint|write|guitar|arte|hobby|ocio|lazer)\b/i] },
  { domain: "travel_mobility", contextBoost: 0.45, patterns: [/\b(travel|trip|flight|hotel|airport|drive|vacation|viaje|viagem|aeroporto|voo)\b/i] },
  { domain: "life_goals_planning", contextBoost: 0.45, patterns: [/\b(goal|plan|milestone|target|vision|long term|short term|objetivo|meta|planejamento|planificacion)\b/i] },
  { domain: "personal_narrative", contextBoost: 0.45, patterns: [/\b(used to|now i|turning point|my story|chapter|antes eu|agora eu|mi historia)\b/i] },
  { domain: "digital_behavior", contextBoost: 0.45, patterns: [/\b(youtube|instagram|telegram|whatsapp|chatgpt|grok|app|screen time|discord|x.com)\b/i] },
  { domain: "reputation_network_capital", contextBoost: 0.35, patterns: [/\b(trust|reliable|reputation|recommend|reference|confiavel|reputacion|confianza)\b/i] },
  { domain: "ethics_privacy_boundaries", contextBoost: 0.5, patterns: [/\b(privacy|consent|boundary|confidential|secret|share this|privacidade|consentimento|limite|confidencial)\b/i] },
  { domain: "risk_safety", contextBoost: 0.45, patterns: [/\b(risk|danger|safety|legal|liability|fraud|scam|risco|seguranca|peligro|estafa)\b/i] },
  { domain: "meaning_spirituality", contextBoost: 0.45, patterns: [/\b(purpose|meaning|spiritual|god|prayer|church|meditation|proposito|espiritual|dios|oracion)\b/i] },
  { domain: "meta_memory_quality", contextBoost: 0.4, patterns: [/\b(not sure|i think|maybe|contradict|unclear|dont remember|nao lembro|talvez|no recuerdo)\b/i] }
];

const SYSTEM_EVENT_PATTERNS: RegExp[] = [
  /messages and calls are end-to-end encrypted/i,
  /this message was deleted/i,
  /you deleted this message/i,
  /missed (voice|video) call/i,
  /created this group/i,
  /joined using (this|our) group'?s invite link/i,
  /left( the group)?/i,
  /changed (the )?(group )?(description|subject|icon)/i,
  /changed their phone number/i,
  /security code (changed|has changed)/i,
  /as mensagens e chamadas (sao|estao) protegidas com a criptografia de ponta a ponta/i,
  /apagou esta mensagem/i,
  /chamada de (voz|video) perdida/i,
  /criou este grupo/i,
  /entrou usando (o )?link de convite/i,
  /mudou (o )?(assunto|icone|descricao) (do )?grupo/i,
  /(seu|teu) codigo de seguranca mudou/i,
  /(mudou|trocou) de numero/i,
  /los mensajes y las llamadas estan cifrados de extremo a extremo/i,
  /elimino este mensaje/i,
  /llamada de (voz|video) perdida/i,
  /creo este grupo/i,
  /se unio mediante el enlace (de invitacion|de invitación)/i,
  /cambio (el )?(asunto|icono|descripcion|descripción) del grupo/i,
  /el codigo de seguridad (cambio|cambió)/i,
  /cambio su numero/i
];

function detectSystemEvent(text: string, sourceSystem?: string): { isSystemEvent: boolean; reasons: string[] } {
  const source = String(sourceSystem ?? "").toLowerCase();
  const normalized = normalize(text);
  if (!normalized) {
    return { isSystemEvent: true, reasons: ["empty_text"] };
  }

  const reasons: string[] = [];
  for (const pattern of SYSTEM_EVENT_PATTERNS) {
    if (pattern.test(normalized)) {
      reasons.push(`matched:${pattern.source.slice(0, 48)}`);
    }
  }

  if ((source === "whatsapp" || source === "telegram") && /^.{0,2}(messages and calls|as mensagens e chamadas|los mensajes y las llamadas)\b/i.test(normalized)) {
    reasons.push("messaging_boilerplate");
  }

  return { isSystemEvent: reasons.length > 0, reasons };
}

function scoreMatches(text: string, patterns: RegExp[]): number {
  let hits = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) hits += 1;
  }
  return hits;
}

function mergeScores(primaryHits: number, contextHits: number, contextBoost: number): number {
  const raw = primaryHits * 0.5 + contextHits * contextBoost * 0.35;
  return clamp01(raw);
}

function inferTraits(text: string, context: string): Record<string, number> {
  const combined = `${text} ${context}`;
  const profile: Array<{ key: string; patterns: RegExp[] }> = [
    { key: "big5_conscientiousness", patterns: [/\b(discipline|routine|organized|consistent|planejamento|organizado|consistente)\b/i] },
    { key: "big5_extraversion", patterns: [/\b(party|social|friends|networking|outgoing|extrovert|amigos|social)\b/i] },
    { key: "big5_openness", patterns: [/\b(creative|curious|explore|learn|new ideas|criativo|curioso|aprender)\b/i] },
    { key: "big5_agreeableness", patterns: [/\b(empathy|kind|helpful|supportive|empat|gentil|ajudar|solidario)\b/i] },
    { key: "big5_neuroticism", patterns: [/\b(anxious|worried|stressed|panic|ansioso|preocupado|estressado)\b/i] }
  ];

  const out: Record<string, number> = {};
  for (const trait of profile) {
    const hits = scoreMatches(combined, trait.patterns);
    if (hits > 0) {
      out[trait.key] = clamp01(0.35 + hits * 0.22);
    }
  }
  return out;
}

function extractConversationTarget(sourceConversationId?: string | null): string | undefined {
  const source = String(sourceConversationId ?? "").trim();
  if (!source) return undefined;
  const match = source.match(/whatsapp(?:\s+chat)?\s*[-:]\s*(.+?)(?:\.zip)?(?:___chat)?$/i);
  if (!match?.[1]) return undefined;
  return match[1].replace(/_/g, " ").trim();
}

function inferRelationshipHints(text: string, sourceSystem?: string, sourceConversationId?: string | null): RelationshipHint[] {
  const normalized = normalize(text);
  const targetHint = sourceSystem === "whatsapp" ? extractConversationTarget(sourceConversationId) : undefined;
  const hints: RelationshipHint[] = [];

  const add = (relationType: RelationshipHint["relationType"], confidence: number, reason: string): void => {
    hints.push({ relationType, confidence: clamp01(confidence), reason, targetHint });
  };

  if (/\b(wife|husband|spouse|girlfriend|boyfriend|partner|esposa|marido|novia|novio|namorada|namorado|te amo|my love|mi amor|amor)\b/i.test(normalized)) {
    add("spouse_partner", 0.92, "romantic_terms");
  }
  if (/\b(mom|dad|mother|father|brother|sister|family|mae|pai|irmao|irma|familia|tio|tia)\b/i.test(normalized)) {
    add("family", 0.88, "family_terms");
  }
  if (/\b(friend|buddy|bro|amigo|amiga|maninha|mano|bestie)\b/i.test(normalized)) {
    add("friend", 0.82, "friendship_terms");
  }
  if (/\b(client|deadline|meeting|project|repo|ticket|colleague|coworker|cliente|reuniao|trabalho)\b/i.test(normalized)) {
    add("colleague", 0.78, "work_terms");
  }
  if (/\b(group|community|network|team|grupo|comunidad|time)\b/i.test(normalized)) {
    add("community", 0.68, "group_terms");
  }

  if (hints.length === 0 && sourceSystem === "whatsapp" && targetHint) {
    add("friend", 0.4, "direct_chat_inference");
  }

  const dedupe = new Map<string, RelationshipHint>();
  for (const hint of hints) {
    const key = `${hint.relationType}:${hint.reason}:${hint.targetHint ?? ""}`;
    const prev = dedupe.get(key);
    if (!prev || hint.confidence > prev.confidence) dedupe.set(key, hint);
  }
  return Array.from(dedupe.values());
}

export function inferStructuredSignals(params: {
  text: string;
  contextWindow?: string[];
  sourceSystem?: string;
  sourceConversationId?: string | null;
}): StructuredSignals {
  const textNorm = normalize(params.text);
  const contextNorm = normalize((params.contextWindow ?? []).join(" \n "));
  const systemEvent = detectSystemEvent(textNorm, params.sourceSystem);

  if (systemEvent.isSystemEvent) {
    const domainEvidence = {} as Record<TaxonomyDomain, string[]>;
    for (const domain of TAXONOMY_DOMAINS) {
      domainEvidence[domain] = [];
    }
    return {
      language: detectLanguage(`${textNorm} ${contextNorm}`),
      domainScores: emptyDomainScores(),
      domainTop: [],
      domainEvidence,
      traitScores: {},
      relationshipHints: [],
      confidence: 0.05,
      isSystemEvent: true,
      noiseReasons: systemEvent.reasons
    };
  }

  const domainScores = {} as Record<TaxonomyDomain, number>;
  const domainEvidence = {} as Record<TaxonomyDomain, string[]>;

  for (const entry of ONTOLOGY) {
    const directHits = scoreMatches(textNorm, entry.patterns);
    const contextHits = contextNorm ? scoreMatches(contextNorm, entry.patterns) : 0;
    let score = mergeScores(directHits, contextHits, entry.contextBoost);

    if (entry.domain === "romantic_relationship" && sourceSystemIsPersonal(params.sourceSystem)) {
      score = clamp01(score + (extractConversationTarget(params.sourceConversationId) ? 0.05 : 0));
    }

    domainScores[entry.domain] = score;
    const evidence: string[] = [];
    if (directHits > 0) evidence.push(`direct_hits:${directHits}`);
    if (contextHits > 0) evidence.push(`context_hits:${contextHits}`);
    domainEvidence[entry.domain] = evidence;
  }

  const domainTop = TAXONOMY_DOMAINS
    .filter((domain) => domainScores[domain] >= 0.25)
    .sort((a, b) => domainScores[b] - domainScores[a])
    .slice(0, 8);

  const traitScores = inferTraits(textNorm, contextNorm);
  const relationshipHints = inferRelationshipHints(textNorm, params.sourceSystem, params.sourceConversationId);

  const meanTop = domainTop.length === 0 ? 0 : domainTop.reduce((acc, domain) => acc + domainScores[domain], 0) / domainTop.length;
  const confidence = clamp01(meanTop * 0.75 + (Object.keys(traitScores).length > 0 ? 0.08 : 0) + (relationshipHints.length > 0 ? 0.08 : 0));

  return {
    language: detectLanguage(`${textNorm} ${contextNorm}`),
    domainScores,
    domainTop,
    domainEvidence,
    traitScores,
    relationshipHints,
    confidence,
    isSystemEvent: false,
    noiseReasons: []
  };
}

function sourceSystemIsPersonal(sourceSystem?: string): boolean {
  const source = String(sourceSystem ?? "").toLowerCase();
  return source === "whatsapp" || source === "telegram" || source === "manual";
}
