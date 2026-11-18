/**
 * A model setting (Settings → AI agent, OPENAI_*_MODEL, agent:model-test): the model name, optionally with
 * a reasoning effort after "@", e.g. "gpt-5.4-mini@low". A plain name = default effort. Pure.
 */

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ModelSetting {
  model: string;
  effort: ReasoningEffort | null;
}

/** GPT-5.x and the o-series take reasoning_effort and max_completion_tokens; GPT-4.x doesn't. */
export const isReasoningModel = (model: string) => /^(gpt-5|o\d)/.test(model);

/** "gpt-5.4-mini@low" → model + effort. An unknown effort stays part of the name, so it has no price and is refused. */
export function parseModelSetting(setting: string): ModelSetting {
  const at = setting.lastIndexOf("@");
  const effort = at < 0 ? "" : setting.slice(at + 1);
  if (!(REASONING_EFFORTS as readonly string[]).includes(effort)) return { model: setting, effort: null };
  return { model: setting.slice(0, at), effort: effort as ReasoningEffort };
}

/** The problem with a setting for the Settings form; null = fine. */
export function modelSettingProblem(setting: string): string | null {
  const { model, effort } = parseModelSetting(setting);
  if (!/^[\w.:-]+$/.test(model)) return `Use a model name, optionally with an effort: name@${REASONING_EFFORTS.join("|")}.`;
  return effort && !isReasoningModel(model) ? `${model} doesn't take a reasoning effort.` : null;
}

// Reasoning counts towards this limit; a decision is a few hundred tokens of JSON.
export const MAX_COMPLETION_TOKENS = 6000;

/** The request parameters a model family needs next to messages / response_format. */
export function modelParams(setting: string): { model: string; reasoning_effort?: ReasoningEffort; max_completion_tokens?: number } {
  const { model, effort } = parseModelSetting(setting);
  if (!isReasoningModel(model)) return { model };
  // Only GPT-5.1 and later accept "none"; gpt-5, its mini/nano and the o-series start at "minimal" / "low".
  const lowest: ReasoningEffort = /^gpt-5\.\d/.test(model) ? "none" : model.startsWith("gpt-5") ? "minimal" : "low";
  return { model, reasoning_effort: effort ?? lowest, max_completion_tokens: MAX_COMPLETION_TOKENS };
}
