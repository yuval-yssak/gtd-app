import { createFileRoute } from '@tanstack/react-router'
import { ClarifyPage } from '../../Pages/ClarifyPage'

export const Route = createFileRoute('/_authenticated/clarify')({
  component: ClarifyPage,
})
