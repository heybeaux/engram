import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CloudLinkService } from './cloud-link.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';

@ApiTags('cloud')
@Controller('v1/cloud')
@UseGuards(ApiKeyOrJwtGuard)
@ApiBearerAuth()
export class CloudLinkController {
  constructor(private readonly cloudLinkService: CloudLinkService) {}

  @Post('link')
  @HttpCode(200)
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Link instance to OpenEngram Cloud (admin only)' })
  async link(
    @Req() req: any,
    @Body()
    body: {
      apiKey: string;
      localAgentId?: string;
      cloudAgentId?: string;
      localUserId?: string;
      cloudUserId?: string;
      userExternalId?: string;
    },
  ) {
    return this.cloudLinkService.linkCloud(req.accountId, body.apiKey, {
      localAgentId: body.localAgentId,
      cloudAgentId: body.cloudAgentId,
      localUserId: body.localUserId,
      cloudUserId: body.cloudUserId,
      userExternalId: body.userExternalId,
    });
  }

  @Delete('link')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AdminGuard)
  @ApiOperation({
    summary: 'Unlink instance from OpenEngram Cloud (admin only)',
  })
  async unlink(@Req() req: any) {
    await this.cloudLinkService.unlinkCloud(req.accountId);
  }

  @Get('status')
  @ApiOperation({ summary: 'Get cloud link status' })
  async status(@Req() req: any) {
    return this.cloudLinkService.getStatus(req.accountId);
  }

  @Post('refresh')
  @HttpCode(200)
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Refresh cloud subscription status (admin only)' })
  async refresh(@Req() req: any) {
    return this.cloudLinkService.refreshSubscription(req.accountId);
  }

  @Get('health')
  @ApiOperation({
    summary: 'Health check: verify cloud link credentials and API reachability',
  })
  async healthCheck(@Req() req: any) {
    return this.cloudLinkService.healthCheck(req.accountId);
  }
}
