
import { redirect } from "next/navigation"

import { authOptions } from "@/lib/auth"
import { db } from "@/lib/db"
import { getCurrentUser } from "@/lib/session"
import { DashboardHeader } from "@/components/header"
import { DashboardShell } from "@/components/shell"
import { ChatbotCreateButton } from "@/components/chatbot-create-button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Icons } from "@/components/icons"
import { OpenAIForm } from "@/components/openai-config-form"
import { siteConfig } from "@/config/site"


export const metadata = {
  title: `${siteConfig.name} - Dashboard`,
}

export default async function DashboardPage() {
  const user = await getCurrentUser()

  if (!user) {
    redirect(authOptions?.pages?.signIn || "/login")
  }

  const bots = await db.chatbot.count({
    where: {
      userId: user.id,
    },
  })

  const crawlers = await db.crawler.count({
    where: {
      userId: user.id,
    },
  })

  const files = await db.file.count({
    where: {
      userId: user.id,
    },
  })

  const messageCountLast30Days = await db.message.count({
    where: {
      userId: user.id,
      createdAt: {
        gte: new Date(new Date().setDate(new Date().getDate() - 30))
      }
    }
  })

  const openaiConfig = await db.openAIConfig.findFirst({
    select: {
      id: true,
      globalAPIKey: true,
    },
    where: {
      userId: user.id,
    },
  })

  return (
    <DashboardShell>
      <DashboardHeader heading="Dashboard" text="Welcome to your chatbot dashboard">
        <ChatbotCreateButton />
      </DashboardHeader>
      <div>
        {!openaiConfig ?
          <OpenAIForm user={{ id: user.id }} />
          :
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">
                  Number of chatbot
                </CardTitle>
                <Icons.bot className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{bots}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">
                  Number of crawlers
                </CardTitle>
                <Icons.post className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{crawlers}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">
                  Number of files
                </CardTitle>
                <Icons.folder className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{files}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">
                  Messages last 30 days
                </CardTitle>
                <Icons.message className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{messageCountLast30Days}</div>
              </CardContent>
            </Card>
          </div>
        }
      </div>
    </DashboardShell>
  )
}