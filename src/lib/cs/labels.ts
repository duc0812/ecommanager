import type { CsCategory, CsSentiment, CsUrgency } from '@/lib/cs/triage'
import type { FactoryState } from '@/lib/cs/order-context'

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
