ALTER TABLE route_mappings ADD COLUMN chat_openai_route TEXT;
ALTER TABLE route_mappings ADD COLUMN work_openai_route TEXT;

UPDATE route_mappings
SET
  chat_openai_route = 'free-chat-openai',
  work_openai_route = 'free-work-openai',
  updated_at = CURRENT_TIMESTAMP
WHERE logical_model_id = 'zhiyuan-free';
