import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { EmbeddingService } from './embedding.service';
import { IsString, IsOptional, IsArray } from 'class-validator';

class EmbeddingRequestDto {
  @IsString()
  input: string | string[];

  @IsOptional()
  @IsString()
  model?: string;
}

/**
 * OpenAI-compatible /v1/embeddings endpoint.
 * Proxies to the configured embedding provider (local engram-embed or cloud).
 * Allows external tools (OpenClaw memorySearch, Forge, etc.) to use Engram as
 * a drop-in embedding provider.
 */
@Controller('v1')
@UseGuards(ApiKeyGuard)
export class EmbeddingProxyController {
  constructor(private readonly embeddingService: EmbeddingService) {}

  @Post('embeddings')
  async embeddings(@Body() dto: EmbeddingRequestDto) {
    const texts = Array.isArray(dto.input) ? dto.input : [dto.input];

    const embeddings: { object: string; embedding: number[]; index: number }[] = [];
    let totalTokens = 0;

    for (let i = 0; i < texts.length; i++) {
      const vector = await this.embeddingService.embedOne(texts[i]);
      embeddings.push({
        object: 'embedding',
        embedding: vector,
        index: i,
      });
      // Rough token estimate: ~4 chars per token
      totalTokens += Math.ceil(texts[i].length / 4);
    }

    return {
      object: 'list',
      data: embeddings,
      model: this.embeddingService.getModelName() || dto.model || 'bge-base-en-v1.5',
      usage: {
        prompt_tokens: totalTokens,
        total_tokens: totalTokens,
      },
    };
  }
}
