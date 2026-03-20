import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

import { db } from "@/lib/db"
import OpenAI from "openai";
import { getUserSubscriptionPlan } from "@/lib/subscription";
import { RequiresHigherPlanError } from "@/lib/exceptions";
import { importChatbotSchema } from "@/lib/validations/importChatbot";

export const maxDuration = 60;

export async function POST(req: Request) {
    try {
        const session = await getServerSession(authOptions)

        if (!session) {
            return new Response("Unauthorized", { status: 403 })
        }

        // Validate user subscription plan
        const { user } = session
        const subscriptionPlan = await getUserSubscriptionPlan(user.id)

        const count = await db.chatbot.count({
            where: {
                userId: user.id,
            },
        })

        if (count >= subscriptionPlan.maxChatbots) {
            throw new RequiresHigherPlanError()
        }

        const json = await req.json()
        const body = importChatbotSchema.parse(json)

        const openAIConfig = await db.openAIConfig.findUnique({
            select: {
                globalAPIKey: true,
                id: true,
            },
            where: {
                userId: session?.user?.id
            }
        })

        if (!openAIConfig?.globalAPIKey) {
            return new Response("Missing your global OpenAI API key, please configure your account.", { status: 400 })
        }

        try {
            const openaiTest = new OpenAI({
                apiKey: body.openAIKey
            ,
            timeout: 60000})
            await openaiTest.models.list()
        } catch (error) {
            return new Response("Invalid OpenAI API key", { status: 400, statusText: "Invalid OpenAI API key" })
        }

        try {
            const openaiClient = new OpenAI({
                apiKey: body.openAIKey
            ,
            timeout: 60000})
            await openaiClient.beta.assistants.retrieve(body.openAIAssistantId)
        } catch (error) {
            return new Response("Invalid OpenAI Assistant ID", { status: 400, statusText: "Invalid OpenAI Assistant ID" })
        }

        const chatbot = await db.chatbot.create({
            data: {
                name: body.name,
                openaiKey: body.openAIKey,
                openaiId: body.openAIAssistantId,
                userId: user?.id,
                welcomeMessage: body.welcomeMessage,
                chatbotErrorMessage: body.chatbotErrorMessage,
                isImported: true
            },
            select: {
                id: true,
            },
        })

        return new Response(JSON.stringify({ chatbot }))
    } catch (error) {
        console.error(error)

        if (error instanceof RequiresHigherPlanError) {
            return new Response("Upgrade to higher plan", { status: 402 })
        }

        return new Response(null, { status: 500 })
    }
}

