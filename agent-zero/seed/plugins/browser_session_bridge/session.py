from copy import copy

def bind(agent, call_data, role):
    model = call_data.get('model')
    if not agent or not model or 'chatgpt-browser' not in str(getattr(model, 'model_name', '')):
        return
    context_id = str(agent.context.id)
    suffix = f'{role}:{agent.number}'
    if role == 'utility':
        # Utility prompts contain changing context. Hashing them creates a new
        # browser conversation per prompt. Reuse a chat-local auxiliary session;
        # the gateway supplies the complete current task on each invocation.
        suffix += ':v3'
    cloned = copy(model)
    cloned.kwargs = dict(model.kwargs)
    # The gateway owns serialization and its single format repair attempt.
    # Do not multiply those calls at the SDK and model-wrapper layers.
    cloned.kwargs['num_retries'] = 0
    cloned.kwargs['a0_retry_attempts'] = 0
    cloned.kwargs['extra_headers'] = {**cloned.kwargs.get('extra_headers', {}),
        'X-A0-Conversation-ID': context_id, 'X-A0-Call-Scope': suffix}
    call_data['model'] = cloned
