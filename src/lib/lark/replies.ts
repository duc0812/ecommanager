export function replyAccepted(taskKey: string, instruction: string): string {
  const text = instruction.trim().slice(0, 120)
  return text ? `Đã nhận: ${taskKey} — ${text}. Kết quả xem trên tool.` : `Đã nhận: ${taskKey}. Kết quả xem trên tool.`
}

export const replyAppended = (taskKey: string) => `Đã thêm vào yêu cầu đang chờ của ${taskKey}. Kết quả xem trên tool.`

export const replyRunning = (taskKey: string) =>
  `Agent đang làm ${taskKey}. Đã ghi yêu cầu vào ghi chú của task; nếu kết quả chưa đúng hãy trả lại trên tool.`

export const REPLY_SENT = "Đơn đã gửi xưởng — hãy bấm 'Mở lại để sửa' trên tool và chọn lý do"

export const replyAskCustomer = (taskKey: string) => `${taskKey} đang chờ khách trả lời — bấm Tiếp tục trên tool rồi nhắn lại.`

export const replyCancelled = (taskKey: string) => `${taskKey} đã huỷ, không nhận yêu cầu.`

export const replyOrderClosed = (taskKey: string) => `${taskKey}: đơn đã giao hoặc đã đóng — không nhận yêu cầu.`

export const replyWhatToFix = (taskKey: string) => `Cần sửa gì ở ${taskKey}? Hãy ghi rõ chỗ sai.`

export const REPLY_OTHER = 'Bot làm được: sửa mẫu, làm mẫu, làm mockup cho một đơn cụ thể. Hãy nhắn kèm mã đơn, ví dụ: LIT6262_1 sửa sao trên mũ bị lệch.'

export const REPLY_UNCLEAR = 'Chưa rõ đơn nào. Hãy gửi mã đơn và dòng, ví dụ: LIT6262_1.'

export const replyAmbiguous = (ref: string, candidates: string[]) => `${ref} có nhiều dòng: ${candidates.join(', ')}. Hãy ghi rõ dòng cần làm.`

export const REPLY_OUT_OF_SCOPE = 'Bot chỉ nhận việc của Design Studio (sửa mẫu, làm mẫu, mockup).'

export const REPLY_NOT_READ = 'Bot chưa đọc được yêu cầu (lỗi AI). Thử lại sau, hoặc trả lại task trên tool.'

export const REPLY_FAILED = 'Bot không xử lý được yêu cầu, thử lại sau.'
