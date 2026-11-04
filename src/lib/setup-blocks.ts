export type SetupBlock = 'store' | 'fulfill' | 'design' | 'marketing' | 'seller'

export type SetupLink = { href: string; icon: string; label: string; hint: string; superAdminOnly?: boolean }

export type SetupBlockInfo = { id: SetupBlock; label: string; icon: string; hint: string; links: SetupLink[] }

/** The Setup page by team. A section that saves something stays on this page; a setting with its own page is linked. */
export const SETUP_BLOCKS: SetupBlockInfo[] = [
  {
    id: 'store', label: 'Store', icon: 'store', hint: 'Kết nối cửa hàng Shopify và chăm sóc khách của store',
    links: [{ href: '/cs/settings', icon: 'tune', label: 'Cài đặt CS', hint: 'Cài đặt chăm sóc khách' }],
  },
  {
    id: 'fulfill', label: 'Fulfill', icon: 'local_shipping', hint: 'Xưởng, cách đẩy đơn sang xưởng và tracking',
    links: [
      { href: '/fulfillment/suppliers', icon: 'factory', label: 'Suppliers', hint: 'Xưởng, bảng giá, template' },
      { href: '/fulfillment/mapping', icon: 'account_tree', label: 'Product Mapping', hint: 'Sản phẩm nào đi xưởng nào' },
      { href: '/fulfillment/auto-fulfill', icon: 'bolt', label: 'Auto Fulfill', hint: 'Sheet tracking, tự fulfill trên Shopify' },
    ],
  },
  {
    id: 'design', label: 'Design', icon: 'brush', hint: 'Nơi lưu file in và công cụ của đội design',
    links: [{ href: '/design-studio/settings', icon: 'settings', label: 'Design Studio', hint: 'Cài đặt của đội design' }],
  },
  {
    id: 'marketing', label: 'Marketing', icon: 'campaign', hint: 'Quảng cáo Meta và công cụ theo dõi đối thủ',
    links: [
      { href: '/setup/meta', icon: 'campaign', label: 'Meta', hint: 'Ad Account và gán vào Project' },
      { href: '/setup/meta-rates', icon: 'currency_exchange', label: 'Meta Exchange Rate', hint: 'Tỷ giá tính chi phí' },
    ],
  },
  {
    id: 'seller', label: 'Seller', icon: 'group', hint: 'Dự án, nhân sự và tài khoản đăng nhập',
    links: [
      { href: '/setup/projects', icon: 'folder', label: 'Projects', hint: 'Tạo và xem Project' },
      { href: '/setup/hr', icon: 'group', label: 'HR', hint: 'Nhân sự và gán vào Project' },
      { href: '/setup/users', icon: 'admin_panel_settings', label: 'Users', hint: 'Tài khoản và phân quyền' },
      { href: '/projects/seller-profit', icon: 'workspace_premium', label: 'Seller Profit', hint: 'Lợi nhuận theo seller', superAdminOnly: true },
    ],
  },
]

/** The block a URL opens. Coming back from Google's consent lands on the block of the card that started it. */
export function blockFromSearch(search: string): SetupBlock {
  const params = new URLSearchParams(search)
  const asked = params.get('block')
  const known = SETUP_BLOCKS.find(b => b.id === asked)
  if (known) return known.id
  if (params.get('sheets')) return 'fulfill'
  if (params.get('google')) return 'design'
  return 'store'
}
