/** @flow */
import { spawn } from 'child_process';
import ConsumerComponent from '../../consumer/component';
import * as globalConfig from '../../api/consumer/lib/global-config';
import { CFG_CI_FUNCTION_PATH_KEY, CFG_CI_ENABLE_KEY } from '../../constants';

function defaultCIFunc(id: string, scopePath: string) {
  const child = spawn(process.argv[0], ['./ci-worker.js'], {
    detached: true,
    env: { 
      __id__: id,
      __scope__: scopePath,
    },
    stdio: [ 'ignore', 'ignore', 'ignore' ]
  });

  child.unref();
}

export default (component: ConsumerComponent, scopePath: string) => {
  const enableCI = globalConfig.getSync(CFG_CI_ENABLE_KEY);
  const ciFuncPath = globalConfig.getSync(CFG_CI_FUNCTION_PATH_KEY);

  if (!enableCI && !ciFuncPath) return component;

  const id = component.id.toString();
  let ciFunc;

  if (!ciFuncPath) ciFunc = defaultCIFunc;
  // $FlowFixMe
  else ciFunc = require(ciFuncPath);

  ciFunc(id, scopePath);
  return component;
};