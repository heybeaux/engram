import {
  Controller,
  Post,
  Patch,
  Get,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { TaskService } from './task.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { QueryTaskDto } from './dto/query-task.dto';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { UserId } from '../common/decorators/user-id.decorator';

@Controller(['v1/tasks', 'v1/delegation/tasks'])
@UseGuards(ApiKeyOrJwtGuard)
export class TaskController {
  constructor(private readonly taskService: TaskService) {}

  @Post()
  create(@UserId() userId: string, @Body() dto: CreateTaskDto) {
    return this.taskService.create(userId, dto);
  }

  @Patch(':id')
  update(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateTaskDto,
  ) {
    return this.taskService.update(userId, id, dto);
  }

  @Get()
  findAll(@UserId() userId: string, @Query() query: QueryTaskDto) {
    return this.taskService.findAll(userId, query);
  }

  @Get(':id')
  findOne(@UserId() userId: string, @Param('id') id: string) {
    return this.taskService.findOne(userId, id);
  }
}
