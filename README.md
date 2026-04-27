# Fill feedbacks automatically
- i handed claude code the bits erp feedback bs and got it to automate it using playwright

# HOW TO USE THIS STUFF
- You need a chromium based browser for this.
Close all other Chrome Windows

- Start up a chrome instance with the debug adapter on:
_On Fedora Linux_
```
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-feedback
```
_On MacOS_
```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-feedback
```
_On Windows_
```
start chrome --remote-debugging-port=9222 --user-data-dir="%TEMP%\chrome-feedback"
```
- Then open up the ERP and navigate to the feedback page
- Then run the script:
```
npm install
node fill-feedback.js
```

Oh yeah, and you need node for this as well.

## a note
if you have already filled some feedbacks or only want to automate some of them, then what you can do is:
    ```
    node fill-feedback.js --start=X --count=Y
    ```
    where X is the feedback entry and Y is the number of courses to autofill.

# Fixes + Feedback
this is 350 lines of vibecoded shit and I don't like feedback. It either works or it doesn't.
