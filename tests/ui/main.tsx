import {createRoot} from 'react-dom/client';
import {LNewsAssistant} from '../../src/components/LNewsAssistant';
import '../../src/styles.css';
createRoot(document.getElementById('root')!).render(<main style={{padding:24,maxWidth:1700,margin:'auto'}}><LNewsAssistant importedRuns={[]} onSync={()=>{}} syncBusy={false}/></main>);
