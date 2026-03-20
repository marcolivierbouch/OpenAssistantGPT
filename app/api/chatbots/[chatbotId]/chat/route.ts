import { db } from "@/lib/db"
import OpenAI from "openai"

import { z } from "zod"
import { getUserSubscriptionPlan } from "@/lib/subscription";
import { AssistantResponse } from '@/lib/assistant-response';
import { zfd } from "zod-form-data";
import { Message } from "openai/resources/beta/threads/messages.mjs";
import { fileTypesFullList } from "@/lib/validations/codeInterpreter";
import { fileTypes as searchFile } from "@/lib/validations/fileSearch";
import { File } from "buffer";
import { getClientIP } from "@/lib/getIP";

export const maxDuration = 300;

const routeContextSchema = z.object({
    params: z.object({
        chatbotId: z.string(),
    }),
})

const schema = zfd.formData({
    threadId: z.string().or(z.undefined()),
    message: zfd.text(),
    clientSidePrompt: z.string().or(z.undefined()),
    file: z.instanceof(Blob).or(z.string()),
    filename: z.string(),
});

export async function OPTIONS(req: Request) {
    return new Response('Ok', { status: 200 })
}

export async function POST(
    req: Request,
    context: z.infer<typeof routeContextSchema>
) {
    try {
        const { params } = routeContextSchema.parse(context)

        const chatbot = await db.chatbot.findUnique({
            select: {
                id: true,
                openaiKey: true,
                userId: true,
                openaiId: true,
                chatbotErrorMessage: true,
                maxCompletionTokens: true,
                maxPromptTokens: true,
            },
            where: {
                id: params.chatbotId,
            },
        })

        if (!chatbot) {
            return new Response(null, { status: 404 })
        }

        const openai = new OpenAI({
            apiKey: chatbot.openaiKey,
            timeout: 60000,
        })

        const input = await req.formData();

        const data = schema.parse(input);

        // Create a thread if needed
        const threadId = data.threadId != '' ? data.threadId : (await openai.beta.threads.create({

        })).id

        let openAiFile: OpenAI.Files.FileObject | null = null;

        if (data.filename !== '') {
            const file = new File([data.file], data.filename, { type: data.file.type });

            if (data.file.size > 0) {
                openAiFile = await openai.files.create({
                    file,
                    purpose: "assistants"
                });
            }
        }

        let fileInterpreter = false;
        let fileSearch = false;
        if (openAiFile) {
            if (fileTypesFullList.includes(data.filename.split('.').pop()?.toLocaleLowerCase()!)) {
                fileInterpreter = true;
            }
            if (searchFile.includes(data.filename.split('.').pop()!)) {
                fileSearch = true;
            }
        }

        const toolList = [
            fileInterpreter ? { type: "code_interpreter" } : null,
            fileSearch ? { type: "file_search" } : null
        ].filter(Boolean)

        // Add a message to the thread
        const createdMessage = await openai.beta.threads.messages.create(threadId!, {
            role: 'user' as 'user' | 'assistant',
            content: data.message.toString(),
            attachments: openAiFile ? [
                {
                    file_id: openAiFile.id,
                    tools: toolList
                }
            ] : []
        });



        return AssistantResponse(
            { threadId, messageId: createdMessage.id, chatbotId: params.chatbotId },
            async ({ sendMessage, forwardStream, sendDataMessage }) => {

                try {
                    const plan = await getUserSubscriptionPlan(chatbot.userId)
                    if (plan.unlimitedMessages === false) {
                        const messageCount = await db.message.count({
                            where: {
                                userId: chatbot.userId,
                                createdAt: {
                                    gte: new Date(new Date().setDate(new Date().getDate() - 30))
                                }
                            }
                        })
                        console.log(`Message count: ${messageCount}`)
                        if (messageCount >= plan.maxMessagesPerMonth!) {
                            console.log(`Reached message limit ${chatbot.userId}`)
                            sendMessage({
                                id: "end",
                                role: 'assistant',
                                content: [{ type: 'text', text: { value: "You have reached your monthly message limit. Upgrade your plan to continue using your chatbot." } }]
                            });
                            return;
                        }
                    }

                    // Run the assistant on the thread
                    const runStream = openai.beta.threads.runs.stream(threadId!, {
                        assistant_id: chatbot.openaiId,
                        instructions: (data.clientSidePrompt || "").replace('+', '') || "",
                        max_completion_tokens: chatbot.maxCompletionTokens,
                        max_prompt_tokens: chatbot.maxPromptTokens,
                    });

                    let runResult = await forwardStream(runStream);

                    // validate if there is any error
                    if (runResult == undefined) {
                        console.log(`Error running assistant ${chatbot.openaiId} on thread ${threadId}`)

                        // set the error if last_error is not null
                        let errorMessage = 'Unknown error'
                        if (runStream.currentEvent()?.data.last_error) {
                            errorMessage = runStream.currentEvent()?.data.last_error.message
                        }

                        await db.chatbotErrors.create({
                            data: {
                                errorMessage: errorMessage,
                                threadId: threadId || '',
                                chatbotId: chatbot.id,
                            }
                        })

                        sendMessage({
                            id: "end",
                            role: 'assistant',
                            content: [{
                                type: 'text', text: { value: chatbot.chatbotErrorMessage }
                            }]
                        });
                        return;
                    }

                    // Get new thread messages (after our message)
                    const responseMessages: Message[] = (
                        await openai.beta.threads.messages.list(threadId, {
                            after: createdMessage.id,
                            order: 'asc',
                        })
                    ).data;

                    for (const message of responseMessages) {
                        let response = ''
                        if (message.content[0].type == 'text') {
                            response = message.content[0].text.value
                        } else if (message.content[0].type == 'image_file') {
                            response = message.content[0].image_file.file_id
                        } else if (message.content[0].type == 'image_url') {
                            response = message.content[0].image_url.url
                        }

                        await db.message.create({
                            data: {
                                chatbotId: params.chatbotId,
                                userId: chatbot.userId,
                                message: data.message,
                                threadId: threadId,
                                response: response,
                                userIP: getClientIP(),
                                from: req.headers.get("origin") || "unknown",
                            }
                        })

                    }
                } catch (error) {
                    console.error(error)
                    sendMessage({
                        id: "end",
                        role: 'assistant',
                        content: [{ type: 'text', text: { value: chatbot.chatbotErrorMessage } }]
                    });
                }
            },
        );

    } catch (error) {
        console.error(error)
        if (error instanceof z.ZodError) {
            return new Response(JSON.stringify(error.issues), { status: 422 })
        }

        if (error instanceof OpenAI.APIError) {
            return new Response(error.message, { status: 401 })
        }

        return new Response(null, { status: 500 })
    }
}
