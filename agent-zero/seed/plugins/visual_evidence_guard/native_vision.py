"""Explicit visual detail for Kimi; retain binary images and message metadata."""

def detailed_messages(messages):
    result = []
    for message in messages:
        content = getattr(message, 'content', None)
        if not isinstance(content, list):
            result.append(message)
            continue
        changed = False
        parts = []
        for part in content:
            if isinstance(part, dict) and part.get('type') == 'image_url':
                image = part.get('image_url')
                if isinstance(image, dict) and not image.get('detail'):
                    part = {**part, 'image_url': {**image, 'detail': 'high'}}
                    changed = True
            parts.append(part)
        result.append(message.model_copy(update={'content': parts}) if changed else message)
    return result
