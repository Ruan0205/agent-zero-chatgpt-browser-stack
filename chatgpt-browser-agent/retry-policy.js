'use strict';

function isProviderMessageLimit(error) {
  return /Messages limit reached|reached your (?:message|usage) limit|Limite de mensagens (?:atingido|alcançado)|Too many requests|temporarily limited access to your conversations|provider_message_limit/i.test(String(error?.message || error || ''));
}

function retryProviderRejection(error, attempt, maximum) {
  return attempt < maximum && isProviderMessageLimit(error);
}

module.exports={isProviderMessageLimit,retryProviderRejection};
