import { del } from '@vercel/blob';
import { NextResponse } from 'next/server';
import { getServerSession } from "next-auth/next"

import { authOptions } from "@/lib/auth"
import { db } from '@/lib/db';
import OpenAI from 'openai';
import { z } from 'zod';

const routeContextSchema = z.object({
    params: z.object({
        fileId: z.string(),
    }),
})

async function verifyCurrentUserHasAccessToFile(fileId: string) {
    const session = await getServerSession(authOptions)

    const count = await db.file.count({
        where: {
            id: fileId,
            userId: session?.user?.id,
        },
    })

    return count > 0
}


export async function DELETE(
    request: Request,
    context: z.infer<typeof routeContextSchema>
) {
    try {
        const session = await getServerSession(authOptions)

        if (!session) {
            return new Response("Unauthorized", { status: 403 })
        }

        const { params } = routeContextSchema.parse(context)

        if (!(await verifyCurrentUserHasAccessToFile(params.fileId))) {
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
            return new Response("Missing OpenAI API key", { status: 400, statusText: "Missing OpenAI API key" })
        }

        const file = await db.file.findUnique({
            select: {
                id: true,
                openAIFileId: true,
                blobUrl: true,
                name: true,
            },
            where: {
                id: params.fileId
            }
        })

        if (!file) {
            return new Response(null, { status: 404 })
        }

        await del(file.blobUrl);

        try {
            const openai = new OpenAI({
                apiKey: openAIConfig?.globalAPIKey
            ,
            timeout: 60000})
    
            await openai.files.del(file.openAIFileId)
        } catch (error) {
            console.log(`Cant delete file in OpenAI ${error}`)
        }

        await db.file.delete({
            where: {
                id: params.fileId,
            }
        })

        return NextResponse.json({ deleted: true }, { status: 200 });
    } catch (error) {
        console.error(error)
        return new Response(null, { status: 500 })
    }

}
