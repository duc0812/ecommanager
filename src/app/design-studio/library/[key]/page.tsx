import { redirect } from 'next/navigation'

export default function LibraryProductRedirect({ params }: { params: { key: string } }) {
  redirect(`/design-studio/products/${params.key}`)
}
