"use client";

import type { FileUIPart } from "ai";
import {
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments";

export interface MessageAttachmentsProps {
  attachments: FileUIPart[];
  messageId: string;
  className?: string;
  onRemove?: (id: string) => void;
}

export function MessageAttachments({
  attachments,
  messageId,
  className,
  onRemove,
}: MessageAttachmentsProps) {
  if (attachments.length === 0) return null;

  return (
    <Attachments className={className} variant="grid">
      {attachments.map((file, i) => {
        const id =
          "id" in file && typeof file.id === "string"
            ? file.id
            : `file-${messageId}-${i}`;
        return (
          <Attachment
            data={{ ...file, id }}
            key={id}
            onRemove={onRemove ? () => onRemove(id) : undefined}
            title={file.filename}
          >
            <AttachmentPreview />
            {onRemove && <AttachmentRemove />}
          </Attachment>
        );
      })}
    </Attachments>
  );
}
