import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  HttpException,
  HttpStatus,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiSecurity } from '@nestjs/swagger';
import { WebhookService } from './webhook.service';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { CreateWebhookDto, UpdateWebhookDto } from './dto/webhook.dto';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';

/**
 * GIN-38: All webhook management endpoints require authentication via
 * ApiKeyOrJwtGuard (X-AM-API-Key or Authorization Bearer token).
 * Unauthenticated requests receive a 401 Unauthorized response.
 */
@ApiTags('webhooks')
@ApiBearerAuth()
@ApiSecurity('x-am-api-key')
@Controller('v1/webhooks')
@UseGuards(ApiKeyOrJwtGuard)
export class WebhookController {
  constructor(
    private webhookService: WebhookService,
    private deliveryService: WebhookDeliveryService,
  ) {}

  /** Resolve the authenticated user's ID from the request context set by ApiKeyOrJwtGuard. */
  private resolveUserId(req: any): string {
    const userId = req.user?.id ?? req.userId;
    if (!userId) {
      throw new HttpException(
        { statusCode: 401, error: 'Unauthorized', message: 'Unable to resolve authenticated user' },
        HttpStatus.UNAUTHORIZED,
      );
    }
    return userId;
  }

  @Post()
  @ApiOperation({ summary: 'Create a webhook subscription' })
  @ApiResponse({ status: 201, description: 'Webhook created.' })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid credentials.' })
  async create(@Req() req: any, @Body() dto: CreateWebhookDto) {
    const userId = this.resolveUserId(req);
    try {
      return await this.webhookService.create(userId, dto);
    } catch (err: any) {
      throw new HttpException(
        { statusCode: 400, error: 'Bad Request', message: err.message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get()
  @ApiOperation({ summary: 'List webhook subscriptions for the authenticated user' })
  @ApiResponse({ status: 200, description: 'List of webhooks.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  async list(@Req() req: any) {
    const userId = this.resolveUserId(req);
    return this.webhookService.list(userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a webhook subscription by ID' })
  @ApiResponse({ status: 200, description: 'Webhook found.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiResponse({ status: 404, description: 'Not found.' })
  async getById(@Req() req: any, @Param('id') id: string) {
    const userId = this.resolveUserId(req);
    const sub = await this.webhookService.getById(id, userId);
    if (!sub) {
      throw new HttpException(
        { statusCode: 404, error: 'Not Found', message: 'Webhook not found' },
        HttpStatus.NOT_FOUND,
      );
    }
    return sub;
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a webhook subscription' })
  @ApiResponse({ status: 200, description: 'Webhook updated.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiResponse({ status: 404, description: 'Not found.' })
  async update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateWebhookDto) {
    const userId = this.resolveUserId(req);
    try {
      return await this.webhookService.update(id, userId, dto);
    } catch (err: any) {
      throw new HttpException(
        { statusCode: 404, error: 'Not Found', message: err.message },
        HttpStatus.NOT_FOUND,
      );
    }
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a webhook subscription' })
  @ApiResponse({ status: 200, description: 'Webhook deleted.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiResponse({ status: 404, description: 'Not found.' })
  async delete(@Req() req: any, @Param('id') id: string) {
    const userId = this.resolveUserId(req);
    try {
      return await this.webhookService.delete(id, userId);
    } catch (err: any) {
      throw new HttpException(
        { statusCode: 404, error: 'Not Found', message: err.message },
        HttpStatus.NOT_FOUND,
      );
    }
  }

  @Post(':id/test')
  @ApiOperation({ summary: 'Send a test event to a webhook' })
  @ApiResponse({ status: 200, description: 'Test event sent.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiResponse({ status: 404, description: 'Not found.' })
  async test(@Req() req: any, @Param('id') id: string) {
    const userId = this.resolveUserId(req);
    try {
      return await this.deliveryService.sendTestEvent(id, userId);
    } catch (err: any) {
      throw new HttpException(
        { statusCode: 404, error: 'Not Found', message: err.message },
        HttpStatus.NOT_FOUND,
      );
    }
  }

  @Get(':id/deliveries')
  @ApiOperation({ summary: 'List delivery history for a webhook' })
  @ApiResponse({ status: 200, description: 'Delivery history.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiResponse({ status: 404, description: 'Not found.' })
  async deliveries(
    @Req() req: any,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    const userId = this.resolveUserId(req);
    try {
      return await this.webhookService.getDeliveries(
        id,
        userId,
        limit ? parseInt(limit, 10) : 50,
      );
    } catch (err: any) {
      throw new HttpException(
        { statusCode: 404, error: 'Not Found', message: err.message },
        HttpStatus.NOT_FOUND,
      );
    }
  }
}
