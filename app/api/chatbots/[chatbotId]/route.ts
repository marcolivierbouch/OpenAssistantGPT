import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { chatbotSchema } from "@/lib/validations/chatbot";
import { getServerSession } from "next-auth";
import OpenAI from "openai";
import { z } from "zod";
import { fileTypes as codeFile } from "@/lib/validations/codeInterpreter";
import { fileTypes as searchFile } from "@/lib/validations/fileSearch";

export const maxDuration = 300;

const routeContextSchema = z.object({
  params: z.object({
    chatbotId: z.string(),
  }),
})

async function verifyCurrentUserHasAccessToChatbot(chatbotId: string) {
  const session = await getServerSession(authOptions)

  const count = await db.chatbot.count({
    where: {
      id: chatbotId,
      userId: session?.user?.id,
    },
  })

  return count > 0
}

export async function GET(
  req: Request,
  context: z.infer<typeof routeContextSchema>
) {

  const { params } = routeContextSchema.parse(context)

  if (!(await verifyCurrentUserHasAccessToChatbot(params.chatbotId))) {
    return new Response(null, { status: 403 })
  }

  try {
    const chatbot = await db.chatbot.findUnique({
      select: {
        id: true,
        name: true,
        createdAt: true,
      },
      where: {
        id: params.chatbotId,
      },
    })

    return new Response(JSON.stringify(chatbot))
  } catch (error) {
    return new Response(null, { status: 500 })
  }
}


export async function PATCH(
  req: Request,
  context: z.infer<typeof routeContextSchema>
) {
  const session = await getServerSession(authOptions)
  const { params } = routeContextSchema.parse(context)

  if (!(await verifyCurrentUserHasAccessToChatbot(params.chatbotId))) {
    return new Response(null, { status: 403 })
  }

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

  const body = await req.json()
  const payload = chatbotSchema.parse(body)

  try {
    const openaiTest = new OpenAI({
      apiKey: payload.openAIKey
    ,
            timeout: 60000})
    await openaiTest.models.list()
  } catch (error) {
    return new Response("Invalid OpenAI API key", { status: 400, statusText: "Invalid OpenAI API key" })
  }

  try {
    const chatbot = await db.chatbot.update({
      where: {
        id: params.chatbotId
      },
      data: {
        name: payload.name,
        welcomeMessage: payload.welcomeMessage,
        prompt: payload.prompt,
        chatbotErrorMessage: payload.chatbotErrorMessage,
        openaiKey: payload.openAIKey,
        modelId: payload.modelId,
        rightToLeftLanguage: payload.rightToLeftLanguage,
      },
      select: {
        id: true,
        name: true,
        openaiId: true,
        prompt: true,
        modelId: true,
      },
    })

    const currentFiles = await db.chatbotFiles.findMany({
      where: {
        chatbotId: chatbot.id,
      },
      select: {
        id: true,
        fileId: true,
      }
    })

    try {
      await db.chatbotFiles.deleteMany({
        where: {
          id: {
            in: currentFiles.map((file) => file.id)
          }
        }
      })
    } catch (error) {
      console.log("No file to delete")
    }

    await db.chatbotFiles.createMany({
      data: payload.files.map((fileId: string) => ({
        chatbotId: chatbot.id,
        fileId: fileId,
      }))
    })

    const openai = new OpenAI({
      apiKey: openAIConfig?.globalAPIKey
    ,
            timeout: 60000})

    const model = await db.chatbotModel.findFirst({
      where: {
        id: chatbot.modelId,
      },
      select: {
        id: true,
        name: true,
      }
    })

    const files = await db.file.findMany({
      where: {
        id: {
          in: payload.files
        },
      },
      select: {
        id: true,
        name: true,
        openAIFileId: true,
      }
    })

    // validate file extension to create vector store or user code interpreter
    let bodyTools = {
      'code_interpreter': {
        file_ids: []
      },
      'file_search': {
        vector_store_ids: []
      }
    };

    // validate file extension to create vector store 
    const allFileforFileSearch = files.filter((f) => searchFile.includes(f.name.split('.').pop()!));
    console.log(allFileforFileSearch);

    const allFileforCodeInterpreter = files.filter((f) => codeFile.includes(f.name.split('.').pop()?.toLocaleLowerCase()!));
    console.log(allFileforCodeInterpreter);

    bodyTools['code_interpreter'] = {
      file_ids: allFileforCodeInterpreter.map((f) => f.openAIFileId)
    };

    if (allFileforFileSearch.length > 0) {
      const vectorStores = await openai.beta.vectorStores.list();
      const vectorStore = vectorStores.data.find((vs) => vs.name === `Vector Store - ${body.name}`);

      if (vectorStore) {
        await openai.beta.vectorStores.del(vectorStore.id);
      }

      const batch = await openai.beta.vectorStores.create({
        name: `Vector Store - ${body.name}`,
        file_ids: allFileforFileSearch.map((f) => f.openAIFileId)
      });

      bodyTools['file_search'] = {
        vector_store_ids: [batch.id]
      };
    }

    await openai.beta.assistants.update(
      chatbot.openaiId,
      {
        name: chatbot.name,
        instructions: chatbot.prompt,
        model: model?.name,
        tools: [{ type: "file_search" }, { type: "code_interpreter" }],
        tool_resources: {
          ...bodyTools
        },
      }
    )

    return new Response(JSON.stringify(chatbot))
  } catch (error) {
    console.log(error)
    return new Response(null, { status: 500 })
  }
}

export async function DELETE(
  req: Request,
  context: z.infer<typeof routeContextSchema>
) {

  const { params } = routeContextSchema.parse(context)

  if (!(await verifyCurrentUserHasAccessToChatbot(params.chatbotId))) {
    return new Response(null, { status: 403 })
  }

  try {
    const session = await getServerSession(authOptions)

    const chatbot = await db.chatbot.findUnique({
      select: {
        id: true,
        name: true,
        openaiId: true,
        isImported: true,
      },
      where: {
        id: params.chatbotId
      }
    })

    if (!chatbot!.isImported) {
      try {
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
          return new Response("Missing OpenAI API key", { status: 403 })
        }

        const openai = new OpenAI({
          apiKey: openAIConfig?.globalAPIKey
        ,
            timeout: 60000})

        await openai.beta.assistants.del(chatbot?.openaiId || '')
      } catch (error) {
        console.log(error)
      }
    }

    await db.chatbot.delete({
      where: {
        id: params.chatbotId
      }
    })

    return new Response(null, { status: 204 })
  } catch (error) {
    console.log(error)
    return new Response(null, { status: 500 })
  }
}