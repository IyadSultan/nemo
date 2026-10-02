-- Hey my brain
-- A voice-control window, not a browser tab.
-- The green button uses the same live voice model as Nemo,
-- so it hears the microphone and talks back.

local PORT = "3001"
local VOICE_URL = "http://127.0.0.1:" .. PORT .. "/voice.html"
local menu = hs.menubar.new()

local function serverUp()
    local code = hs.execute("curl -s -o /dev/null -w '%{http_code}' --max-time 2 " .. VOICE_URL)
    return code and code:match("^200") ~= nil
end

local function openVoice()
    if not serverUp() then
        hs.alert.show("Voice app is not running. In Terminal: npm run brain", 4)
        return
    end
    -- Chrome app window: no address bar, no tabs. Same shape as voice control.
    hs.execute([[open -na "Google Chrome" --args --app=']] .. VOICE_URL .. [[']])
    if menu then menu:setTitle("🧠") end
end

if menu then
    menu:setTitle("🧠")
    menu:setMenu({
        { title = "Open voice control", fn = openVoice },
    })
end

openVoice()
