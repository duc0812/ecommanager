/** Text that came from a task, a queue or a job is shown as data: one line, cut to length. */
export function cutLine(text: string | null | undefined, max: number): string {
  const line = (text ?? '').replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const RESULT_ON_TOOL = 'Kết quả xem trên tool.'

export const replyAccepted = (taskKey: string) => `${taskKey}: đã nhận, Agent đang làm. ${RESULT_ON_TOOL}`

export const replyAppended = (taskKey: string) => `${taskKey}: đã thêm vào yêu cầu đang chờ.`

export const replyRunning = (taskKey: string) =>
  `Agent đang làm ${taskKey}. Đã ghi yêu cầu vào ghi chú của task; nếu kết quả chưa đúng hãy trả lại trên tool.`

export const REPLY_SENT = "Đơn đã gửi xưởng — hãy bấm 'Mở lại để sửa' trên tool và chọn lý do"

export const REPLY_MOCKUP_SENT = 'Đơn đã gửi xưởng — mockup làm trên tool, không cần mở lại.'

export const replyStatusCap = (rest: string[]) => `Hỏi tối đa 3 dòng mỗi lần, xem các dòng còn lại trên tool: ${rest.join(', ')}`

export const replyAskCustomer = (taskKey: string) => `${taskKey} đang chờ khách trả lời — bấm Tiếp tục trên tool rồi nhắn lại.`

export const replyCancelled = (taskKey: string) => `${taskKey} đã huỷ, không nhận yêu cầu.`

export const replyOrderClosed = (taskKey: string) => `${taskKey}: đơn đã giao hoặc đã đóng — không nhận yêu cầu.`

export const replyWhatToFix = (taskKey: string) => `Cần sửa gì ở ${taskKey}? Hãy ghi rõ chỗ sai.`

const HELP_ASK = "Bạn cũng có thể hỏi tiến độ một dòng (ví dụ: LIT6262_1 sao rồi) hoặc hỏi 'việc nào chưa có người làm'."

export const REPLY_OTHER = `Bot làm được: sửa mẫu, làm mẫu, làm mockup cho một đơn cụ thể. Hãy nhắn kèm mã đơn, ví dụ: LIT6262_1 sửa sao trên mũ bị lệch. ${HELP_ASK}`

export const REPLY_UNCLEAR = 'Chưa rõ đơn nào. Hãy gửi mã đơn và dòng, ví dụ: LIT6262_1.'

export const replyAmbiguous = (ref: string, candidates: string[]) => `${ref} có nhiều dòng: ${candidates.join(', ')}. Hãy ghi rõ dòng cần làm.`

export const REPLY_OUT_OF_SCOPE = `Bot chỉ nhận việc của Design Studio (sửa mẫu, làm mẫu, mockup). ${HELP_ASK}`

export const REPLY_NOT_READ = 'Bot chưa đọc được yêu cầu (lỗi AI). Thử lại sau, hoặc trả lại task trên tool.'

export const REPLY_FAILED = 'Bot không xử lý được yêu cầu, thử lại sau.'

export const REPLY_NOTED = ' Yêu cầu của bạn đã được ghi vào task.'

export const replyHeldBefore = (reason: string) => ` Dòng này đang bị giữ ở hàng duyệt local: ${reason.replace(/\s+/g, ' ').trim().slice(0, 300)}`

export const REPLY_BOARD_STALE_REPORT = 'Chưa có dữ liệu tin cậy từ máy local, chưa báo được việc chưa có người làm.'

export const REPLY_LIST_CAP = 'Chỉ nhận 30 dòng mỗi tin, gửi phần còn lại ở tin sau.'

export const SHORT_REASON = {
  SENT: 'đã gửi xưởng', ORDER_CLOSED: 'đơn đã đóng', ASK_CUSTOMER: 'đang hỏi khách', CANCELLED: 'đã huỷ',
  WHAT_TO_FIX: 'cần ghi rõ sửa gì', HOLDER_UNKNOWN: 'chưa rõ ai đang giữ', NOT_QUEUED: 'chưa xếp được việc, xếp lại trên tool',
  SERVER_ERROR: 'lỗi máy chủ, thử lại sau',
} as const

export const AGENT_HOLDER = 'Agent'

const MAX_HOLDER = 40
const MAX_REASON = 80
const MAX_CANDIDATES = 5

export type GroupedLines = {
  accepted: string[]
  held: { key: string; holder: string; minutes?: number | null; qaFailed?: boolean }[]
  refused: { key: string; why: string }[]
  unknown: string[]
  ambiguous: { ref: string; candidates: string[] }[]
}

function heldTiming(h: GroupedLines['held'][number]): string {
  if (h.qaFailed) return h.minutes ? `, lỗi QA, giữ lại sau ${h.minutes} phút` : ', lỗi QA'
  return h.minutes ? `, còn khoảng ${h.minutes} phút` : ''
}

/** One reply for a message that names several lines; a group with nothing in it is left out. */
export function replyGrouped(g: GroupedLines): string {
  const out: string[] = []
  if (g.accepted.length) out.push(`Đã nhận ${g.accepted.length} dòng, Agent làm lần lượt: ${g.accepted.join(', ')}.`)
  if (g.held.length) {
    const held = g.held.map(h => `${h.key} (${cutLine(h.holder, MAX_HOLDER)}${heldTiming(h)})`)
    out.push(`Đang có bên giữ: ${held.join(', ')}.`)
  }
  if (g.refused.length) out.push(`Không làm: ${g.refused.map(r => `${r.key} (${cutLine(r.why, MAX_REASON)})`).join(', ')}.`)
  if (g.unknown.length) out.push(`Không tìm thấy: ${g.unknown.join(', ')}.`)
  if (g.ambiguous.length) {
    const asked = g.ambiguous.map(a => `${a.ref} (${a.candidates.slice(0, MAX_CANDIDATES).join(', ')}${a.candidates.length > MAX_CANDIDATES ? ', …' : ''})`)
    out.push(`Trùng nhiều đơn, gửi lại kèm số dòng: ${asked.join(', ')}.`)
  }
  if (g.accepted.length) out.push(RESULT_ON_TOOL)
  return out.join('\n')
}
