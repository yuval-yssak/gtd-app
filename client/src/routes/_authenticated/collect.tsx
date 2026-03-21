import { createFileRoute } from '@tanstack/react-router'
import { CollectPage } from '../../Pages/CollectPage'

export const Route = createFileRoute('/_authenticated/collect')({
  component: CollectPage,
})
