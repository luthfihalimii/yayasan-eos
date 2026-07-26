import { BadRequestException, Controller, Headers, Param, Post, RawBodyRequest, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../../core/auth/decorators';
import { WebhookChannel, WebhookInboxService } from './webhook-inbox.service';
import { extractBusinessKey } from './payment.service';

const CHANNELS: Record<string, WebhookChannel> = { va: 'DOKU_VA', qris: 'DOKU_QRIS' };

/**
 * @Public: webhook diautentikasi HMAC signature (§5.1), bukan JWT.
 * rawBody wajib — digest dihitung dari byte persis yang DOKU kirim.
 */
@Controller('webhooks/doku')
export class PaymentController {
  constructor(private readonly inbox: WebhookInboxService) {}

  @Public()
  @Post(':channel')
  async handle(
    @Param('channel') channelParam: string,
    @Headers('client-id') clientId = '',
    @Headers('request-id') requestId = '',
    @Headers('request-timestamp') requestTimestamp = '',
    @Headers('signature') signature = '',
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
  ) {
    const channel = CHANNELS[channelParam];
    if (!channel) throw new BadRequestException('Channel tidak dikenal');
    const rawBody = req.rawBody?.toString('utf8');
    if (!rawBody) throw new BadRequestException('Body kosong');

    let businessKey: string;
    try {
      businessKey = extractBusinessKey(channel, JSON.parse(rawBody));
    } catch {
      throw new BadRequestException('Payload bukan JSON valid');
    }

    const result = await this.inbox.receive(
      channel,
      { clientId, requestId, requestTimestamp, signature },
      `/webhooks/doku/${channelParam}`,
      rawBody,
      businessKey,
    );
    // DOKU retry pada non-2xx; 200 untuk PROCESSED dan DUPLICATE (§5.1).
    res.status(result.httpStatus).json({ outcome: result.outcome });
  }
}
