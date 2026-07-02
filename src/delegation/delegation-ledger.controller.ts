import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { DelegationLedgerService } from './delegation-ledger.service';
import { RecordValidationDto } from './dto/record-validation.dto';
import { AttachReceiptDto } from './dto/attach-receipt.dto';
import { RecordEventDto } from './dto/record-event.dto';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { UserId } from '../common/decorators/user-id.decorator';

@Controller('v1/delegation')
@UseGuards(ApiKeyOrJwtGuard)
export class DelegationLedgerController {
  constructor(private readonly ledger: DelegationLedgerService) {}

  @Post('events')
  recordEvent(@UserId() userId: string, @Body() dto: RecordEventDto) {
    return this.ledger.recordEvent(userId, dto);
  }

  @Post('contracts/:id/validations')
  recordValidation(
    @UserId() userId: string,
    @Param('id') contractId: string,
    @Body() dto: RecordValidationDto,
  ) {
    return this.ledger.recordValidation(userId, contractId, dto);
  }

  @Post('tasks/:id/receipts')
  attachReceipt(
    @UserId() userId: string,
    @Param('id') taskId: string,
    @Body() dto: AttachReceiptDto,
  ) {
    return this.ledger.attachReceipt(userId, taskId, dto);
  }

  @Get('tasks/:id/trust-report')
  taskTrustReport(@UserId() userId: string, @Param('id') taskId: string) {
    return this.ledger.getTaskTrustReport(userId, taskId);
  }

  @Get('trust-reports/:agentId')
  agentTrustReports(
    @UserId() userId: string,
    @Param('agentId') agentId: string,
  ) {
    return this.ledger.getAgentTrustReports(userId, agentId);
  }
}
