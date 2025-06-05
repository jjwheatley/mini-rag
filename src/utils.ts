import {Workspace, WorkspaceLeaf} from "obsidian";
import {VIEW_TYPE} from "./constants";

export const activateViewInWorkspace = async (workspace: Workspace)=> {
	let leaf: WorkspaceLeaf;
	const leaves = workspace.getLeavesOfType(VIEW_TYPE);

	if (leaves.length > 0) { // A leaf with our view already exists, use it
		leaf = leaves[0];
		await workspace.revealLeaf(leaf);// Expand the sidebar to show leaf if it's collapsed
	} else { // View isn't found in workspace, create in sidebar as new leaf
		const rightMostLeaf = workspace.getRightLeaf(false);
		if(rightMostLeaf) {
			leaf = rightMostLeaf
			await leaf.setViewState({type: VIEW_TYPE, active: true});
			await workspace.revealLeaf(leaf);// Expand the sidebar to show leaf if it's collapsed
		}
	}
}
