import { Injectable } from '@nestjs/common';
import type { StructuredMemoryItem } from './dto/structured-recall.dto';
import { CHAIN_OF_NOTE_TEMPLATE } from './chain-of-note.prompt';

@Injectable()
export class ChainOfNoteService {
  buildPrompt(memories: StructuredMemoryItem[], question: string): string {
    return CHAIN_OF_NOTE_TEMPLATE(memories, question);
  }
}
