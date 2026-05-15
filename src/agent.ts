import {
  search_patient,
  verify_insurance,
  lookup_policy,
  find_slots,
  hold_slot,
  create_task,
  draft_message,
  escalate,
  getToolCallsForItem,
  withItemContext,
} from "./tools.js";
import type {
  InboxItem,
  ItemOutput,
  ExtractedIntake,
  Classification,
  Urgency,
  Discipline,
} from "./types.js";

const CLAUDE_API_KEY = process.env.ANTHROPIC_API_KEY;
//const CLAUDE_MODEL = "claude-opus-4-6";
const CLAUDE_MODEL = "claude-haiku-4-5";
const start = performance.now();
interface ClaudeExtractionResponse {
  child_name: string | null;
  dob_or_age: string | null;
  parent_contact: string | null;
  discipline: string[] | null;
  diagnosis_or_concern: string | null;
  payer: string | null;
  member_id: string | null;
  classification: Classification;
  safety_concerns: boolean;
}

export async function runAgent(inbox: InboxItem[]): Promise<ItemOutput[]> {
  const results: ItemOutput[] = [];

  for (const item of inbox) {
    const output = await withItemContext(item.id, async () => {
      return await processItem(item);
    });
    results.push(output);
  }

  return results;
}

function computeUrgency(item: InboxItem, classification: Classification): Urgency {
  const text = `${item.subject} ${item.body}`.toLowerCase();

  // P0 
  if (/(abuse|harm|neglect|unsafe|emergency|call 911)/i.test(text)) {
    return "P0";
  }

  // P1
  if (
    /\b(today|urgent|asap|cannot wait|same day|immediately)\b/i.test(text)
  ) {
    return "P1";
  }

  if (classification === "scheduling") {
    return /\burgent|today/i.test(text) ? "P1" : "P2";
  }
  return "P2";
}
async function processItem(item: InboxItem): Promise<ItemOutput> {
  // Use Claude to intelligently extract intake info and classify
  let extracted: ExtractedIntake;
  let classification: Classification;
  let hasSafetyConcerns = false;

  try {
    const claudeAnalysis = await analyzeItemWithClaude(item);
    extracted = {
      child_name: claudeAnalysis.child_name,
      dob_or_age: claudeAnalysis.dob_or_age,
      parent_contact: claudeAnalysis.parent_contact || item.sender,
      discipline: claudeAnalysis.discipline as Discipline[] | null,
      diagnosis_or_concern: claudeAnalysis.diagnosis_or_concern,
      payer: claudeAnalysis.payer,
      member_id: claudeAnalysis.member_id,
    };
    classification = claudeAnalysis.classification;
    hasSafetyConcerns = claudeAnalysis.safety_concerns;
  } catch (error) {
    console.error(`Failed to analyze item ${item.id} with Claude:`, error);
    console.log('Fallback to basic')
    // Fall back to basic extraction
    extracted = basicExtractIntakeInfo(item);
    classification = basicClassifyItem(item);
    hasSafetyConcerns = false;
  }

  // Handle safeguarding concerns (P0)
  if (hasSafetyConcerns || classification === "safeguarding") {
    const escalationResult = await escalate({
      item_id: item.id,
      reason: "Potential safeguarding concern in inbox item",
      severity: "P0",
    });

    return {
      item_id: item.id,
      classification: "safeguarding",
      urgency: "P0",
      requires_human_review: true,
      extracted_intake: extracted,
      missing_info: [],
      tools_called: getToolCallsForItem(item.id),
      recommended_next_action: "Immediate clinical lead review",
      draft_reply: null,
      task_ids: [],
      escalation: { reason: "Safeguarding concern", severity: "P0" },
      decision_rationale:
        "Safeguarding disclosures require immediate escalation per policy.",
    };
  }

  if (classification === "new_referral") {
    return await handleNewReferral(item, extracted);
  }

  if (classification === "existing_patient_request") {
    return await handleExistingPatientRequest(item, extracted);
  }

  if (classification === "billing_question") {
    return await handleBillingQuestion(item, extracted);
  }

  if (classification === "clinical_question") {
    return await handleClinicalQuestion(item, extracted);
  }

  if (classification === "scheduling") {
    return await handleScheduling(item, extracted);
  }

  if (classification === "complaint") {
    return await handleComplaint(item, extracted);
  }
  if (classification === "missing_paperwork") {
  return await handleExistingPatientRequest(item, extracted);
}

  // Default 
  return {
    item_id: item.id,
    classification,
    urgency: "P3",
    requires_human_review: true,
    extracted_intake: extracted,
    missing_info: [],
    tools_called: getToolCallsForItem(item.id),
    recommended_next_action: "Review and categorize",
    draft_reply: null,
    task_ids: [],
    escalation: null,
    decision_rationale: `Item classified as ${classification}; standard processing.`,
  };
}

async function handleNewReferral(
  item: InboxItem,
  extracted: ExtractedIntake,
): Promise<ItemOutput> {
  const missingInfo = getMissingInfo(extracted);

  // Search for existing patient if we have a name
  if (extracted.child_name) {
    await search_patient({
      name: extracted.child_name,
      dob: extracted.dob_or_age || undefined,
    });
  }

  // Verify insurance if payer info provided
  if (extracted.payer) {
    await verify_insurance({
      payer: extracted.payer,
      member_id: extracted.member_id || undefined,
    });
  }

  // Look up service lines and insurance policy
  await lookup_policy({ topic: "service_lines" });
  await lookup_policy({ topic: "insurance" });

  // Find available slots for requested discipline
  if (extracted.discipline && extracted.discipline.length > 0) {
    const discipline =
      extracted.discipline[0] as "SLP" | "OT" | "PT";
    await find_slots({
      discipline,
    });
  }

  // Create intake task
  const taskResult = await create_task({
    assignee: "intake",
    title: `Review referral: ${extracted.child_name || "unknown patient"}`,
    due: getNextBusinessDay(),
    notes: `New ${extracted.discipline?.[0] || "therapy"} referral from ${item.sender}. Insurance: ${extracted.payer || "not specified"}. Concern: ${extracted.diagnosis_or_concern || "not specified"}`,
  });

  // Draft acknowledgment message
  await draft_message({
    recipient: item.sender,
    channel: item.channel === "email" ? "email" : "portal",
    body: `Thank you for your referral. Our intake team will review your request and contact you within 1 business day to confirm insurance and scheduling.`,
    language: "en",
  });

  return {
    item_id: item.id,
    classification: "new_referral",
    urgency: "P2",
    requires_human_review: true,
    extracted_intake: extracted,
    missing_info: missingInfo,
    tools_called: getToolCallsForItem(item.id),
    recommended_next_action:
      "Intake team: verify insurance, confirm patient details, discuss scheduling preferences",
    draft_reply: "Acknowledgment message ready for review",
    task_ids: [taskResult.data.task_id],
    escalation: null,
    decision_rationale:
      "New referral requires patient search, insurance verification, and availability check before scheduling decision.",
  };
}

async function handleExistingPatientRequest(
  item: InboxItem,
  extracted: ExtractedIntake,
): Promise<ItemOutput> {
  // Look up scheduling and cancellation policy
  await lookup_policy({ topic: "scheduling" });
  await lookup_policy({ topic: "cancellation" });

  const taskResult = await create_task({
    assignee: "front_desk",
    title: `Existing patient request: ${item.subject}`,
    due: getNextBusinessDay(),
    notes: `Item from ${item.sender}. Subject: ${item.subject}`,
  });

  return {
    item_id: item.id,
    classification: "existing_patient_request",
    urgency: "P1",
    requires_human_review: true,
    extracted_intake: extracted,
    missing_info: [],
    tools_called: getToolCallsForItem(item.id),
    recommended_next_action:
      "Front desk: review request type and handle per scheduling/cancellation policy",
    draft_reply: null,
    task_ids: [taskResult.data.task_id],
    escalation: null,
    decision_rationale:
      "Existing patient requests are same-day operational issues.",
  };
}

async function handleBillingQuestion(
  item: InboxItem,
  extracted: ExtractedIntake,
): Promise<ItemOutput> {
  // Verify insurance to provide billing context
  if (extracted.payer) {
    await verify_insurance({
      payer: extracted.payer,
      member_id: extracted.member_id || undefined,
    });
  }

  await lookup_policy({ topic: "insurance" });

  const taskResult = await create_task({
    assignee: "billing",
    title: `Billing question: ${item.subject}`,
    due: getNextBusinessDay(),
    notes: `Item from ${item.sender}. Subject: ${item.subject}`,
  });

  return {
    item_id: item.id,
    classification: "billing_question",
    urgency: "P2",
    requires_human_review: true,
    extracted_intake: extracted,
    missing_info: [],
    tools_called: getToolCallsForItem(item.id),
    recommended_next_action:
      "Billing team: respond with coverage verification and explain copay/deductible",
    draft_reply: null,
    task_ids: [taskResult.data.task_id],
    escalation: null,
    decision_rationale:
      "Routing to billing for standard insurance/coverage processing.",
  };
}

async function handleClinicalQuestion(
  item: InboxItem,
  extracted: ExtractedIntake,
): Promise<ItemOutput> {
  await lookup_policy({ topic: "clinical_advice" });

  const taskResult = await create_task({
    assignee: "clinical_lead",
    title: `Clinical question: ${item.subject}`,
    due: getNextBusinessDay(),
    notes: `Item from ${item.sender}. Subject: ${item.subject}`,
  });

  // Draft a neutral acknowledgment (not clinical advice)
  await draft_message({
    recipient: item.sender,
    channel: item.channel === "email" ? "email" : "portal",
    body: `Thank you for reaching out. A member of our clinical team will review your question and contact you soon.`,
    language: "en",
  });

  return {
    item_id: item.id,
    classification: "clinical_question",
    urgency: "P2",
    requires_human_review: true,
    extracted_intake: extracted,
    missing_info: [],
    tools_called: getToolCallsForItem(item.id),
    recommended_next_action:
      "Clinical lead: review and provide guidance per clinical advice policy",
    draft_reply: "Acknowledgment message ready for review",
    task_ids: [taskResult.data.task_id],
    escalation: null,
    decision_rationale:
      "Clinical questions require clinician review; not suitable for automated response.",
  };
}

async function handleScheduling(
  item: InboxItem,
  extracted: ExtractedIntake,
): Promise<ItemOutput> {
  await lookup_policy({ topic: "scheduling" });

  const taskResult = await create_task({
    assignee: "front_desk",
    title: `Scheduling request: ${item.subject}`,
    due: getNextBusinessDay(),
    notes: `Item from ${item.sender}. Subject: ${item.subject}`,
  });

  return {
    item_id: item.id,
    classification: "scheduling",
    urgency: computeUrgency(item, "scheduling"),
    requires_human_review: true,
    extracted_intake: extracted,
    missing_info: [],
    tools_called: getToolCallsForItem(item.id),
    recommended_next_action:
      "Front desk: discuss availability, find slots, and hold for family confirmation",
    draft_reply: null,
    task_ids: [taskResult.data.task_id],
    escalation: null,
    decision_rationale:
      "Scheduling requests require same-day attention per operations policy.",
  };
}

async function handleComplaint(
  item: InboxItem,
  extracted: ExtractedIntake,
): Promise<ItemOutput> {
  const taskResult = await create_task({
    assignee: "clinical_lead",
    title: `Patient/family complaint: ${item.subject}`,
    due: getNextBusinessDay(),
    notes: `Item from ${item.sender}. Subject: ${item.subject}`,
  });

  return {
    item_id: item.id,
    classification: "complaint",
    urgency: "P1",
    requires_human_review: true,
    extracted_intake: extracted,
    missing_info: [],
    tools_called: getToolCallsForItem(item.id),
    recommended_next_action:
      "Clinical lead: document complaint and prepare response plan",
    draft_reply: null,
    task_ids: [taskResult.data.task_id],
    escalation: null,
    decision_rationale:
      "Complaints require prompt senior review and response within business day.",
  };
}

async function analyzeItemWithClaude(
  item: InboxItem,
): Promise<ClaudeExtractionResponse> {
  if (!CLAUDE_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY environment variable is not set");
  }

  const prompt = `Analyze this pediatric therapy inbox item and extract key information.

Item:
- Channel: ${item.channel}
- From: ${item.sender}
- Subject: ${item.subject}
- Body: ${item.body}

Extract and classify:
1. Child's name (or null)
2. Date of birth (YYYY-MM-DD) or age (or null)
3. Parent/guardian contact info (or null if same as sender)
4. Requested discipline: array of "SLP", "OT", "PT" (or null)
5. Diagnosis, concern, or clinical reason (brief string or null)
6. Insurance payer name (or null)
7. Insurance member ID (or null)
8. Classification (one of: new_referral, existing_patient_request, scheduling, billing_question, clinical_question, missing_paperwork, provider_followup, complaint, safeguarding, spam, other)
9. Safety concerns: true if item mentions harm, abuse, neglect, unsafe conditions, or danger

Respond ONLY with valid JSON, no other text:
{
  "child_name": "string or null",
  "dob_or_age": "string or null",
  "parent_contact": "string or null",
  "discipline": ["SLP"] or null,
  "diagnosis_or_concern": "string or null",
  "payer": "string or null",
  "member_id": "string or null",
  "classification": "new_referral",
  "safety_concerns": false
}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `Claude API error (${response.status}): ${error}`,
    );
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
  };
  const textBlock = data.content.find((block) => block.type === "text");
  if (!textBlock) {
    throw new Error("No text block in Claude response");
  }

  let jsonText = textBlock.text.trim();
  if (jsonText.startsWith("```json")) {
    jsonText = jsonText.replace(/^```json\n/, "").replace(/\n```$/, "");
  } else if (jsonText.startsWith("```")) {
    jsonText = jsonText.replace(/^```\n/, "").replace(/\n```$/, "");
  }

  const parsed = JSON.parse(jsonText) as ClaudeExtractionResponse;
  return parsed;
}
// FALL BACK 
function basicExtractIntakeInfo(item: InboxItem): ExtractedIntake {
  const body = item.body.toLowerCase();
  const subject = item.subject.toLowerCase();
  const fullText = `${subject} ${body}`;

  return {
    child_name: extractName(fullText),
    dob_or_age: extractDobOrAge(fullText),
    parent_contact: item.sender,
    discipline: extractDiscipline(fullText),
    diagnosis_or_concern: extractConcern(fullText),
    payer: extractPayer(fullText),
    member_id: extractMemberId(fullText),
  };
}

function extractName(text: string): string | null {
  const patterns = [
    /(?:child|patient|for)\s+(?:named\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\s+(?:age|dob|born)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }

  return null;
}

function extractDobOrAge(text: string): string | null {
  const dateMatch = text.match(/(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) return dateMatch[1];

  const ageMatch = text.match(/age[:\s]+(\d+)/i);
  if (ageMatch) return `age ${ageMatch[1]}`;

  return null;
}

function extractDiscipline(text: string): Discipline[] | null {
  const disciplines: Discipline[] = [];

  if (/\bslp\b|\bspeech/i.test(text)) {
    disciplines.push("SLP");
  }

  if (/\bot\b|\boccupational/i.test(text)) {
    disciplines.push("OT");
  }

  if (/\bpt\b|\bphysical/i.test(text)) {
    disciplines.push("PT");
  }

  return disciplines.length > 0 ? disciplines : null;
}

function extractConcern(text: string): string | null {
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.length > 20 && !line.match(/^(subject|from|to|date):/i)) {
      return line.substring(0, 100);
    }
  }
  return null;
}

function extractPayer(text: string): string | null {
  const payerPatterns = [
    "aetna",
    "blue cross",
    "bluecross",
    "bcbs",
    "cigna",
    "kaiser",
    "united",
    "uhc",
    "medicaid",
    "beacon",
  ];

  for (const payer of payerPatterns) {
    if (text.includes(payer)) {
      return payer;
    }
  }

  return null;
}

function extractMemberId(text: string): string | null {
  const memberMatch = text.match(
    /(?:member|policy|id)\s*[:#]?\s*([A-Z0-9]{8,})/i,
  );
  return memberMatch ? memberMatch[1] : null;
}

function basicClassifyItem(item: InboxItem): Classification {
  const text = `${item.subject} ${item.body}`.toLowerCase();

  if (
    /harm|abuse|neglect|unsafe|injury|dangerous|call police|911/i.test(text)
  ) {
    return "safeguarding";
  }

  if (
    /referral|dr\.|pediatrician|fax|new patient|evaluation/i.test(
      item.subject,
    )
  ) {
    return "new_referral";
  }

  if (
    /reschedule|cancel|change|appointment|confirm|time|availability|slot/i.test(
      text,
    )
  ) {
    return "scheduling";
  }

  if (
    /insurance|billing|copay|coverage|deductible|claim|auth/i.test(text)
  ) {
    return "billing_question";
  }

  if (
    /will my child|what should|treatment|can you help|advice|recommend/i.test(
      text,
    )
  ) {
    return "clinical_question";
  }

  if (/complaint|unhappy|issue|problem|concern/.test(text)) {
    return "complaint";
  }

  return "other";
}

function getMissingInfo(extracted: ExtractedIntake): string[] {
  const missing: string[] = [];

  if (!extracted.child_name) missing.push("Child name");
  if (!extracted.dob_or_age) missing.push("Date of birth or age");
  if (!extracted.discipline) missing.push("Requested discipline");
  if (!extracted.payer) missing.push("Insurance payer");

  return missing;
}

function getNextBusinessDay(): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  while (tomorrow.getDay() === 0 || tomorrow.getDay() === 6) {
    tomorrow.setDate(tomorrow.getDate() + 1);
  }

  return tomorrow.toISOString().split("T")[0];
}