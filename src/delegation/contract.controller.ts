import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ContractService } from './contract.service';
import { CreateContractDto } from './dto/create-contract.dto';
import { UpdateContractDto } from './dto/update-contract.dto';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { UserId } from '../common/decorators/user-id.decorator';

@Controller(['v1/delegation-contracts', 'v1/delegation/contracts'])
@UseGuards(ApiKeyOrJwtGuard)
export class ContractController {
  constructor(private readonly contractService: ContractService) {}

  @Post()
  create(@UserId() userId: string, @Body() dto: CreateContractDto) {
    return this.contractService.create(userId, dto);
  }

  @Get()
  findAll(@UserId() userId: string, @Query('status') status?: string) {
    return this.contractService.findAll(userId, status as any);
  }

  @Get(':id')
  findOne(@UserId() userId: string, @Param('id') id: string) {
    return this.contractService.findOne(userId, id);
  }

  @Patch(':id')
  update(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateContractDto,
  ) {
    return this.contractService.update(userId, id, dto);
  }
}
