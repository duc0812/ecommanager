import type { CsCategory, CsSentiment, CsUrgency } from '@/lib/cs/triage'
import type { FactoryState } from '@/lib/cs/order-context'
import type { IssueType, Stage } from '@/lib/cs/root-cause-prompt'

export const CATEGORY_LABELS: Record<CsCategory, string> = {
  ADDRESS_CHANGE: 'Đổi địa chỉ',
  CANCEL_ORDER: 'Huỷ đơn',
  ORDER_STATUS: 'Hỏi đơn hàng',
  DAMAGED_OR_DEFECTIVE: 'Hàng lỗi/hỏng',
  WRONG_ITEM: 'Sai hàng',
  MISSING_ITEM: 'Thiếu hàng',
  DELIVERED_NOT_RECEIVED: 'Báo đã giao nhưng chưa nhận',
  REFUND_REQUEST: 'Xin hoàn tiền',
  PRODUCT_QUESTION: 'Hỏi sản phẩm',
  PERSONALIZATION_ISSUE: 'Lỗi cá nhân hoá',
  OTHER: 'Khác',
  SPAM: 'Spam',
}

export const URGENCY_LABELS: Record<CsUrgency, string> = {
  URGENT: 'Gấp',
  HIGH: 'Cao',
  NORMAL: 'Bình thường',
  LOW: 'Thấp',
}

export const SENTIMENT_LABELS: Record<CsSentiment, string> = {
  CALM: 'Bình tĩnh',
  FRUSTRATED: 'Khó chịu',
  ANGRY: 'Tức giận',
  DISPUTE_THREAT: 'Doạ dispute',
}

export const FACTORY_LABELS: Record<FactoryState, string> = {
  NOT_SENT: 'Chưa chuyển xưởng',
  AT_FACTORY: 'Đang ở xưởng',
  SHIPPED: 'Đang vận chuyển',
  DELIVERED: 'Đã giao',
  CANCELLED: 'Đã huỷ',
}

export const STAGE_LABELS: Record<Stage, string> = {
  DESIGN: 'Design',
  FULFILLMENT: 'Fulfillment',
  FACTORY: 'Xưởng',
  CARRIER: 'Vận chuyển',
  CUSTOMER: 'Khách nhập sai',
  LISTING: 'Listing gây hiểu nhầm',
  UNKNOWN: 'Chưa rõ',
}

export const ISSUE_LABELS: Record<IssueType, string> = {
  WRONG_TEXT: 'Sai chữ/tên',
  WRONG_IMAGE: 'Sai hình',
  WRONG_SIZE_COLOR: 'Sai size/màu',
  PRINT_QUALITY: 'Chất lượng in',
  DAMAGED_IN_TRANSIT: 'Hỏng khi vận chuyển',
  LATE_DESIGN: 'Design chậm',
  LATE_HANDOFF: 'Chuyển xưởng chậm',
  LATE_PRODUCTION: 'Xưởng sản xuất chậm',
  LATE_SHIPPING: 'Ship chậm',
  LOST: 'Thất lạc',
  NOT_AS_DESCRIBED: 'Không như mô tả',
  CUSTOMER_INPUT: 'Khách nhập sai',
  OTHER: 'Khác',
}
