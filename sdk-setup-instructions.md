
  Say your project lives at ~/projects/my-app:

  cp ~/Documents/GitHub/ezbase/sdk/src/index.ts ~/projects/my-app/src/lib/ezbase.ts

  Then in your code:

  import EzBase from '@/lib/ezbase'

  const ez = new EzBase('https://your-ezbase-server.com')
