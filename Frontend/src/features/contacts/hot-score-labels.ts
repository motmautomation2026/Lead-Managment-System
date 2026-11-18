/** E3b-2b: the hot-lead score's band (backend domain/leadScore.ts). */
export type HotBand = "hot" | "warm" | "cold";

export const HOT_BAND_LABEL: Record<HotBand, string> = { hot: "Hot", warm: "Warm", cold: "Cold" };

/** The score's reason codes in plain words. */
export const HOT_REASON_LABEL: Record<string, string> = {
  closed: "Closed, Do Not Contact or merged",
  stopped: "Asked us to stop, not interested or annoyed",
  enquiry: "Sent an enquiry",
  enquiry_detailed: "Detailed enquiry",
  enquiry_need: "Named a concrete need",
  enquiry_signal: "Asked about price, a visit or a call",
  consumer: "Looks like a consumer business",
  corporate_email: "Company email address",
  company: "Company known",
  target_industry: "In a target industry",
  revenue: "Revenue known",
  opened: "Opened an email (soft signal)",
  opened_often: "Opened emails more than once (soft signal)",
  replied: "Replied",
  replied_positive: "Replied positively",
  meeting: "Meeting booked",
  proposal: "Proposal sent",
};

export const hotReasonText = (code: string) => HOT_REASON_LABEL[code] ?? code;
