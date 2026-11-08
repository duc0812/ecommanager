export const TASK_TYPES = ['SIZE_CHANGE', 'ADDRESS_CHANGE', 'PERSONALIZATION_CHANGE', 'CANCEL_ORDER', 'RESEND', 'CARRIER_CHECK', 'SUPPLIER_ERROR', 'VERIFY_CUSTOM', 'REFUND', 'DISCOUNT_CODE', 'OTHER'] as const
export type TaskType = (typeof TASK_TYPES)[number]
export const TASK_STATUSES = ['NEW', 'IN_PROGRESS', 'WAITING', 'DONE', 'CANCELLED'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]
export const TASK_DEPTS = ['FULFILLMENT', 'DESIGN', 'CS'] as const
export type TaskDept = (typeof TASK_DEPTS)[number]

// Priority 1 = work a third party (factory, design) must do; 2 = money owed to the customer; 3 = the rest.
export const TASK_META: Record<TaskType, { label: string; dept: TaskDept; priority: number }> = {
  SIZE_CHANGE: { label: 'Đổi size', dept: 'FULFILLMENT', priority: 1 },
  ADDRESS_CHANGE: { label: 'Đổi địa chỉ', dept: 'FULFILLMENT', priority: 1 },
  PERSONALIZATION_CHANGE: { label: 'Sửa thông tin custom', dept: 'DESIGN', priority: 1 },
  CANCEL_ORDER: { label: 'Huỷ đơn', dept: 'FULFILLMENT', priority: 1 },
  RESEND: { label: 'Gửi lại / làm lại', dept: 'FULFILLMENT', priority: 1 },
  CARRIER_CHECK: { label: 'Kiểm tra vận chuyển', dept: 'FULFILLMENT', priority: 1 },
  SUPPLIER_ERROR: { label: 'Lỗi supplier – báo xưởng', dept: 'FULFILLMENT', priority: 1 },
  VERIFY_CUSTOM: { label: 'Xác minh custom', dept: 'CS', priority: 1 },
  REFUND: { label: 'Refund', dept: 'CS', priority: 2 },
  DISCOUNT_CODE: { label: 'Gửi mã giảm giá', dept: 'CS', priority: 2 },
  OTHER: { label: 'Khác', dept: 'CS', priority: 3 },
}
export const STATUS_LABELS: Record<TaskStatus, string> = { NEW: 'Mới', IN_PROGRESS: 'Đang xử lý', WAITING: 'Chờ phản hồi', DONE: 'Xong', CANCELLED: 'Huỷ' }
export const DEPT_LABELS: Record<TaskDept, string> = { FULFILLMENT: 'Fulfillment', DESIGN: 'Design', CS: 'CS' }
export const OPEN_STATUSES: TaskStatus[] = ['NEW', 'IN_PROGRESS', 'WAITING']
